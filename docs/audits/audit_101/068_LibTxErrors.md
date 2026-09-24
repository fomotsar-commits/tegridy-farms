# Agent 068 — Frontend lib: revertDecoder / txErrors / explorer / formatting / nftMetadata

**Scope:** AUDIT-ONLY. Files reviewed:
- `frontend/src/lib/revertDecoder.ts` + `.test.ts`
- `frontend/src/lib/txErrors.ts` + `.test.ts`
- `frontend/src/lib/explorer.ts` (no `.test.ts` exists)
- `frontend/src/lib/formatting.ts` + `.test.ts`
- `frontend/src/lib/nftMetadata.ts` + `.test.ts`

---

## Severity counts

| Severity | Count |
|---|---|
| HIGH | 2 |
| MEDIUM | 4 |
| LOW | 4 |
| INFO | 3 |
| **Total** | **13** |

---

## HIGH

### H-01 — revertDecoder cannot decode Solidity custom errors (4-byte selector ABI errors); user sees raw 0x... hex
**File:** `frontend/src/lib/revertDecoder.ts`
**Lines:** 4–58 (entire module)

`KNOWN_ERRORS` is a hard-coded map of legacy `require("STRING")`-style messages. The decoder does pure substring matching on the wagmi/viem `message` / `shortMessage` / `reason`. It does **not**:

1. Parse the 4-byte selector at the start of revert data (`error CustomError(...)` per Solidity 0.8.4+).
2. Carry an ABI registry of project custom errors (`Locked(uint256 unlockAt)`, `InsufficientLiquidity()`, `OnlyOwner()`, etc. that the V2 contracts use heavily).
3. Decode `BaseError` chains — viem's `cause` traversal (`error.walk()`) is not used. If the inner cause is a `ContractFunctionRevertedError` with `data.errorName`, the decoder ignores it.

**Impact:** When a contract reverts with a modern custom error (which the audit-batched contracts widely use — `Locked`, `Slippage`, `OnlyTimelock`, etc.), the user sees either:
- The raw `Reverted with data: 0xabcdef12...` blob (truncated at 200 chars, line 53–55), or
- The unhelpful generic `"Transaction reverted — the on-chain conditions changed."` because the substring `"execution reverted"` matches first (KNOWN_ERRORS line 18 + the generic loop on line 37–39 is checked before the regex extraction on line 42).

This is a **functional regression vs the on-chain behavior**: the contracts emit precise custom errors but the UX flattens them to one of two strings.

**Recommended fix:**
```ts
import { BaseError, ContractFunctionRevertedError } from 'viem';

if (error instanceof BaseError) {
  const revert = error.walk(e => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const name = revert.data?.errorName ?? '';
    if (name && CUSTOM_ERROR_MAP[name]) return CUSTOM_ERROR_MAP[name];
    if (name) return `Transaction failed: ${name}`;
  }
}
```
…before falling through to the legacy substring path.

**Test gap:** `revertDecoder.test.ts` has zero tests for `BaseError`, `ContractFunctionRevertedError`, `data.errorName`, or 4-byte selector strings. Test on line 35–39 actively documents the over-eager-match behavior as expected, which cements the bug into the test suite.

---

### H-02 — `KNOWN_ERRORS` ordering: generic `"execution reverted"` matches before specific patterns when both substrings co-occur
**File:** `frontend/src/lib/revertDecoder.ts`
**Lines:** 18, 37–39

`Object.entries(KNOWN_ERRORS)` iterates in **insertion order** (ES2015+). The literal string `"execution reverted"` is at line 18 — earlier than the specific phrases like `"user rejected"` (line 19), `"User denied"` (line 20). However, the actual bug is more subtle:

A real viem error message often reads:
```
execution reverted: INSUFFICIENT_OUTPUT_AMOUNT
```
The first loop (lines 37–39) checks `INSUFFICIENT_OUTPUT_AMOUNT` (line 5) *before* `execution reverted` (line 18) — so this case works.

**But** for messages like:
```
execution reverted: Custom error (Reverted with data: 0xabc12345)
```
…there is no entry for `Custom error` or `Reverted with data` in `KNOWN_ERRORS`. The first matching pattern is `execution reverted` → user gets the bland "on-chain conditions changed" message, and the regex on line 42 is never reached because the function already `return`ed on line 38.

**Impact:** All custom-error reverts get coalesced into one unhelpful string. Combined with H-01, the user has no way to know what actually went wrong — even when viem provided the data inline.

**Recommended fix:** Run the regex extraction (line 42) *before* the substring loop (line 37), or remove `'execution reverted'` from `KNOWN_ERRORS` entirely so the regex/specific-pattern path takes precedence.

---

## MEDIUM

### M-01 — `explorer.ts` falls back to mainnet Etherscan for unknown chains → broken/misleading links on custom L2s
**File:** `frontend/src/lib/explorer.ts`
**Lines:** 25, 28–31

```ts
const FALLBACK = 'https://etherscan.io';
export function getExplorerBase(chainId?: number): string {
  if (!chainId) return FALLBACK;
  return EXPLORERS[chainId] ?? FALLBACK;
}
```

A tx submitted on a chain not in the `EXPLORERS` map (e.g., zkSync Era 324, Linea 59144, Scroll 534352, Mantle 5000, Blast 81457, Base testnet alternates, Berachain, Monad, the project's own custom L2/devnet) renders as `https://etherscan.io/tx/0x...` — which **404s on mainnet Etherscan**.

**Impact:**
- The user clicks a tx link, lands on a 404.
- Worse: if the tx hash collides with any unrelated mainnet tx (low prob, but possible for synthetic test hashes), the link surfaces a *different unrelated mainnet tx* — confusing & a phishing-adjacent risk if a malicious dApp populates a fake hash.
- The header comment says "fall back to mainnet Etherscan if the chain is unknown so links still resolve somewhere rather than 404" — but mainnet Etherscan with a non-mainnet hash is still a 404. The comment misleads.

**Recommended fix:** When `chainId` is unknown, return `null` / disable the link rather than emit a wrong URL. Or expose `wagmi`'s configured chain `blockExplorers.default.url` from the chain config so it stays in sync automatically.

**Test gap:** No `explorer.test.ts` exists. None of the 16 call-sites have unit coverage. Several common L2s (zkSync, Linea, Scroll, Mantle, Blast, Berachain, Polygon zkEVM, Optimism Sepolia 11155420) are missing from the map.

---

### M-02 — Missing common chains in EXPLORERS map
**File:** `frontend/src/lib/explorer.ts`
**Lines:** 10–23

Map covers: Ethereum (1, 5, 11155111, 17000), OP (10), Base (8453, 84532), Arbitrum (42161, 421614), Polygon (137), BSC (56), Avalanche (43114).

**Missing (commonly used by dApps in 2026):**
- Optimism Sepolia: 11155420
- Polygon zkEVM: 1101
- zkSync Era: 324, zkSync Sepolia: 300
- Linea: 59144, Linea Sepolia: 59141
- Scroll: 534352, Scroll Sepolia: 534351
- Mantle: 5000
- Blast: 81457
- Berachain: 80094
- Monad testnet: 10143
- Polygon Amoy: 80002 (Mumbai is deprecated)
- Goerli (5) is **deprecated** since 2023 — remove or document.

Combined with M-01, txs on any of these chains link to wrong-network 404s.

---

### M-03 — `formatCurrency` / `formatTokenAmount` emit user-confusing scientific notation
**File:** `frontend/src/lib/formatting.ts`
**Lines:** 9, 27

```ts
if (value > 0 && value < 0.000001) return `$${value.toExponential(2)}`;
// → "$1.00e-7" for value = 1e-7
```
`formatting.test.ts` line 47 confirms: `expect(formatCurrency(0.0000001)).toBe('$1.00e-7')`.

**Impact:**
- Non-technical users misread `$1.00e-7` as "$1.00 e -7" or just give up.
- For low-priced meme tokens (which the project explicitly markets — Toweli token, drop tokens), prices in the 1e-7..1e-9 range are normal. The current rendering looks like an error.
- Better: `$0.0000001` with subscript-zero notation (`$0.0₆1` Uniswap-style), or just `$<0.00001` clamped output.

---

### M-04 — `formatTokenAmount` and `formatCurrency` accept `number` only → `parseFloat` precision loss for big-token balances
**File:** `frontend/src/lib/formatting.ts`
**Lines:** 14, 23–30, 3

```ts
export function formatTokenAmount(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  ...
}
```

`parseFloat('1000000000000000000.123456789')` returns `1e18` (loses fractional digits + rounds the integer part). For a token balance of `1_000_000_000_000_000_001n` wei (1 ether + 1 wei), the fractional 1 wei is silently dropped — minor but an integrity issue when the result is shown as "1.0000" implying perfect precision.

Worse: the function doesn't accept `bigint` at all. Callers must convert via `Number(formatEther(x))` (the very anti-pattern the comment on `formatWei` line 59 warns against). `formatWei` is the bigint-safe variant, but most call-sites still use `formatTokenAmount`.

**Audit signal:** the codebase comment on line 59 acknowledges this anti-pattern exists ("avoids the `Number(formatEther(x)).toFixed(d)` anti-pattern that loses precision"). The fix is partial — `formatWei` exists but isn't enforced.

---

## LOW

### L-01 — `formatWei` truncates fractional digits without rounding
**File:** `frontend/src/lib/formatting.ts`
**Lines:** 61–68

```ts
const frac = formatted.slice(dot + 1).slice(0, displayDecimals).padEnd(displayDecimals, '0');
```
`formatWei(1_999_900_000_000_000_000n, 18, 4)` → `'1.9999'` (truncated). Mathematically `1.99990000…`, but `formatWei(1_99999_999_999_999_999n, 18, 4)` → `'1.9999'` also (truncated), losing the 5th-digit info that should round to `2.0000`. Misleads users about the actual amount, especially for "barely below threshold" cases (e.g., min stake = 2.0 LP, user has 1.99999, displays as 1.9999, user thinks they need to top up by 0.0001 when really only 0.00001 is needed).

**Recommended:** round-half-up at `displayDecimals + 1`.

---

### L-02 — `decodeRevertReason` truncates messages without preserving the salient revert reason
**File:** `frontend/src/lib/revertDecoder.ts`
**Lines:** 53–55

```ts
if (message.length > 200) {
  return message.slice(0, 150) + '…';
}
```
Truncation is from the *start* of the message. viem messages typically prepend the request context (call args, gas, etc.) and put the actual revert reason later. Slicing at 150 chars often **discards the revert reason itself** and keeps the boilerplate. The user sees `"The contract function call reverted. Function: stake(uint256). Args: (1000000000…"` without ever seeing why it reverted.

**Recommended:** prefer the regex on line 42 to extract only the revert payload before length-checking, or scan from the end of the string for the relevant tail.

---

### L-03 — `isUserRejection` checks `message` but not `cause.message` (nested viem errors)
**File:** `frontend/src/lib/txErrors.ts`
**Lines:** 44–52

viem wraps wallet errors with `BaseError → cause → cause`. A `UserRejectedRequestError` from the wallet may surface as the `cause.cause` of an outer `TransactionExecutionError`, where the outer `error.message` says "Transaction execution failed" and the `code` field is undefined at the top level. `isUserRejection` only inspects the top-level `code` / `name` / `message`, so:

- viem 2.x v1-style provider errors with rejection nested two layers deep slip through.
- Result: a true user cancellation gets surfaced as `toast.error("Transaction execution failed")` — false negative the audit prompt explicitly asks about.

**Recommended:**
```ts
if (err instanceof BaseError && err.walk(e => e instanceof UserRejectedRequestError)) return true;
```

**Test gap:** `txErrors.test.ts` line 6–9 only tests a freshly constructed `new UserRejectedRequestError(new Error('rejected'))` — never the realistic wrapped-twice case.

---

### L-04 — `nftMetadata.buildContractMetadata` accepts any `https://...` external_link with no further validation
**File:** `frontend/src/lib/nftMetadata.ts`
**Lines:** 149–151

```ts
if (input.externalLink && !/^https:\/\//i.test(input.externalLink)) {
  throw new Error('external_link must start with https://');
}
```
Accepts `https://attacker.com/phish?x=`, `https://localhost`, `https:// `, any IDN homoglyph. Since `external_link` ends up in OpenSea metadata that becomes a clickable button on the OpenSea collection page, this is a soft phishing-vector affordance (users trust collection metadata).

**Recommended:** parse with `new URL()`, verify `.protocol === 'https:'`, reject hosts matching `localhost` / `127.0.0.1` / private IP ranges.

Also the audit prompt mentioned `nftMetadata` "trusting external tokenURI without sanitization (fetch + render `data:`/`javascript:`)" — **this concern does not apply to `nftMetadata.ts`** because the module is purely a CSV/upload-side builder; it does not fetch tokenURIs from the chain. That fetch logic, if it exists, lives in a different file (probably the on-chain reader hooks). False alarm for this file specifically.

---

## INFO

### I-01 — `formatCurrency` line 11: `value > 0 && value < 0.01` collides with K/M/B/T branches for negative or zero (handled by ordering, but fragile)
The `if`-cascade on lines 5–11 relies on insertion ordering for negative numbers (e.g., `-1_000_000` returns `$-1000000.00` rather than the expected `$-1.00M` because the `>= 1_000_000` checks all fail for negatives). Test on line 64 `expect(formatCurrency(-10)).toBe('$-10.00')` — confirmed but only for small negatives. `formatCurrency(-1_500_000)` would return `$-1500000.00` which is the **opposite** abbreviation behavior of the positive branch. Inconsistent UX.

### I-02 — `txErrors.ts` `extractErrorMessage` uses `||` on trimmed `shortMessage` — a literal `'0'` shortMessage would be skipped (extreme edge, non-issue in practice).
Line 63: `e.shortMessage?.trim() || e.message?.trim() || fallback`. The `||` treats `'0'` as falsy after trim — but since `'0'` is not actually falsy in string form (`'0'.trim()` is `'0'` which is truthy), this is correct. Documenting for completeness.

### I-03 — `formatPercent` cutoff at `>= 10000` produces inconsistent precision
Line 33: `if (value >= 10000) return ${formatNumber(value, 0)}%` — meaning `9999.99%` displays as `9999.99%` but `10000%` displays as `10,000%` (loses decimals AND adds locale separator). Discontinuous. Test on line 178 `expect(formatPercent(1_500_000)).toBe('2M%')` — formatNumber turns 1.5M into `2M` (with `decimals=0` rounding) — accurate, but for an APR display context, an APR of `2M%` is less useful than `1,500,000%`. Stylistic.

---

## Summary verdict

| File | Verdict |
|---|---|
| `revertDecoder.ts` | **Needs work** — does not handle Solidity custom errors at all (H-01) |
| `txErrors.ts` | Mostly solid — minor gap on nested causes (L-03) |
| `explorer.ts` | **Needs work** — wrong-chain links on unknown networks (M-01, M-02), no test file |
| `formatting.ts` | Acceptable, with UX/precision rough edges (M-03, M-04, L-01, I-01) |
| `nftMetadata.ts` | Solid for its actual scope (CSV→metadata); audit's tokenURI-fetch concern doesn't apply here |

**Top-3 priority fixes (in order):**
1. **H-01** — Add viem `BaseError`/`ContractFunctionRevertedError` walking in `revertDecoder.ts` to surface custom-error names from contract reverts.
2. **M-01 + M-02** — Stop falling back to `etherscan.io` for unknown chains in `explorer.ts`; add the missing L2s; add an `explorer.test.ts` file.
3. **L-03** — Make `isUserRejection` walk nested causes via `BaseError.walk()` to prevent false-negative cancellation toasts.

---
*Agent 068 / 101 — frontend libs (revertDecoder, txErrors, explorer, formatting, nftMetadata).*
