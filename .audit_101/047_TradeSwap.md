# Audit 047 — Trade / Swap Surface

**Agent:** 047 / 101 (forensic audit pass)
**Date:** 2026-04-25
**Scope (AUDIT-ONLY — no code changes):**
- `frontend/src/pages/TradePage.tsx`
- `frontend/src/components/swap/{LiquidityTab,DCATab,LimitOrderTab,TokenSelectModal}.tsx`
- `frontend/src/hooks/useSwap.ts`
- `frontend/src/hooks/useSwapAllowance.ts`
- `frontend/src/hooks/useSwapQuote.ts`
- `frontend/src/lib/aggregator.ts`

**Hunt vector counts**

| # | Vector | Count |
|---|---|---|
| 1 | Slippage default too lenient | 1 |
| 2 | Deadline default too long | 1 |
| 3 | Approval not reset between non-zero values (USDT pattern) | 1 |
| 4 | Quote staleness (price moves between fetch and tx) | 2 |
| 5 | Missing minOut on user-confirmed amount (UI ≠ on-chain) | 2 |
| 6 | Token-decimals math wrong | 1 |
| 7 | Custom-token import allowing arbitrary contract / phishing | 2 |
| 8 | MEV warnings absent | 1 |
| 9 | Missing chainId guard in tx submission | 0 |
| 10 | Race when user spams swap button | 2 |
| 11 | Unsanitized token name/symbol rendered | 2 |
| 12 | JSON-RPC error swallowed without surfacing | 3 |

**Severity legend:** H = High, M = Medium, L = Low, I = Info

---

## H-01  [Vector 5 / 4]  Aggregator quote silently overwrites user-confirmed minOut at submit time

**Files:** `frontend/src/hooks/useSwap.ts:231-260`, `frontend/src/hooks/useSwapQuote.ts:262-263, 334-338`

When `selectedRoute === 'aggregator'`, the UI displays the **aggregator output** as `outputFormatted` and computes `minimumReceived` from it (`useSwapQuote.ts:334-338`). The user reads "You receive: X" and "Min. Received: Y" off these values. But at submit time (`useSwap.ts:235-240`) `executeSwap` recomputes `onChainMin` from `selectedOnChainRoute.output` (the on-chain Tegridy/Uniswap quote) — **ignoring the displayed `minimumReceived` entirely**. The user sees a min-received from the aggregator (e.g. 100 TOWELI) but the tx is submitted with a min-received from the on-chain leg (e.g. 95 TOWELI). The displayed `minimumReceived` is therefore advisory only, not enforced. Consequence: divergence between UI promise and on-chain protection — exact inverse of the "user-displayed amount differs from on-chain amount" anti-pattern in the hunt list.

Suggested fix: gate the aggregator-route submit on the displayed `minimumReceived`, or surface "min received (executed via on-chain leg)" separately from the aggregator quote.

---

## H-02  [Vector 4]  Quote staleness — no minimum freshness check before swap execution

**Files:** `frontend/src/hooks/useSwapQuote.ts:189-214` (aggregator path), `:77-83, 102-108` (on-chain quotes)

The aggregator quote has an 800 ms debounce + abort-on-input-change (`:199-213`) but **no maximum age**. If the user types an amount, the quote arrives, the user pauses for 30+ seconds (mempool browsing, wallet confirmation prompt, mobile lock screen), prices move, then they hit Swap — `executeSwap` reads `quote.outputAmount` / `selectedOnChainRoute.output` straight from the last-cached values. wagmi's `useReadContract` hooks have no `refetchInterval` configured for `getAmountsOut` (only the 30 s pair-reserve refetch via `:148, 162, 176`), so on-chain quotes can be tens of seconds stale. There is no warning, no "Quote expired — refresh?" prompt, no implicit re-quote at submit time.

The 5-minute deadline (see M-01) compounds this — a stale quote signed against a generous deadline is a high-EV target for sandwich / backrun bots.

---

## H-03  [Vector 11]  Token symbol from on-chain `symbol()` rendered raw in chips, list rows, and "Recent" pills

**Files:** `frontend/src/components/swap/TokenSelectModal.tsx:390-391, 422-423, 426`, `frontend/src/pages/TradePage.tsx:174, 219, 346`

Custom-token import sanitizes the `importSymbol` at insert-time (`TokenSelectModal.tsx:215-219` strips `[^\x20-\x7E]` and slices to 12 chars), and that sanitized form lands in `customTokens` localStorage. **Good.** But two leak paths remain:

1. **Pre-import preview** (`TokenSelectModal.tsx:422-423, 426, 453`) renders `importSymbol as string` directly into JSX before sanitization — including `(importSymbol as string).slice(0, 2)` on line 423 (icon) and the unescaped form inside the SCAM-WARNING text on line 453. A token `symbol()` returning a 200-character string with right-to-left override (RLO U+202E) or homoglyphs reaches the DOM unsanitized in this preview window.
2. **Token `name`** is never read from chain in custom-import (`:223` sets `name: sanitizedSymbol`), but for `DEFAULT_TOKENS` the hard-coded `name` is rendered (`:391`). DEFAULT list is curated, so this leg is OK. However, **legacy custom tokens persisted in `localStorage` from earlier app versions** (before the L-05 sanitizer landed) could carry malicious symbols and would still be rendered raw on every subsequent visit. There is no migration / re-sanitize on load (`useSwap.ts:49-56`).

React's auto-escaping prevents script injection but does not prevent visual spoofing (zero-width chars, RTL overrides, Unicode lookalikes for "USDC"/"WETH").

---

## H-04  [Vector 10]  Race: spamming Swap during pending state can fire a second tx with stale/different route

**Files:** `frontend/src/hooks/useSwap.ts:207-340`, `frontend/src/pages/TradePage.tsx:414-419`

The Swap button is disabled on `isPending || isConfirming` (TradePage.tsx:415). But:

1. There is a window between `executeSwap()` synchronously firing `writeContract({...})` and wagmi flipping `isPending` to true. If the user double-taps within ~1 frame (not unusual on iOS Safari with Touch Latency), `executeSwap` runs twice. The second invocation re-reads `quote` from React state (which may have re-rendered with a different `selectedRoute` if a parallel aggregator promise resolved between the two clicks) and submits a **second wallet prompt with potentially different args / different router target**. Two approvals, one swap, route mismatch — confusing UX at best, double-spend approve at worst.
2. `lastActionRef.current = 'swap'` is set inside `executeSwap` (`:214`) without checking whether a previous swap is already in-flight. If the receipt-effect for an earlier approve hasn't fired yet, this overwrites the pending tag and the approve toast gets misclassified as a swap toast (silently — only visible via `trackSwap` analytics noise).

A `useRef<boolean>` guard at the top of `executeSwap` returning early when `submitInFlight === true` would close this. Currently absent.

---

## M-01  [Vector 2]  Deadline default 5 min — too long given the lack of quote-freshness guard

**File:** `frontend/src/hooks/useSwap.ts:44`

`const [deadline, setDeadline] = useState(5);` — five-minute default. With H-02 (no quote freshness) and the meta-aggregator latency (800 ms debounce + 7 parallel HTTP fetches), users routinely sign tx with a stale-by-30-s quote, deadline=5min in the future. That window is ample for a builder to sandwich the tx. Industry default is 10–30 minutes for limit-order-style submits, but for a market swap with explicit slippage protection the deadline should be aggressive (60–120 s) — its only purpose is to bound mempool stuck-tx exposure. There is **no deadline UI control** at all (`setDeadline` is exported on line 372 but unused by any tab — confirmed via `Grep`), so users cannot tighten it.

---

## M-02  [Vector 3]  Approve flow does not reset to zero before raising allowance — USDT will revert

**File:** `frontend/src/hooks/useSwapAllowance.ts:59-70`

`approve()` calls ERC-20 `approve(spender, approvalAmount)` directly. If the existing allowance is non-zero (prior partial swap, prior unlimited toggle, prior router migration), USDT (`0xdAC17F...`) will **revert** the approve call because USDT enforces `require(value == 0 || allowance == 0)`. USDT is a default-list token (`tokenList.ts:50-55`), so this is a real path. The user sees "Transaction failed" with no actionable hint. Pattern is well-known: do `approve(spender, 0)` then `approve(spender, amount)` whenever existing allowance > 0 and < requested.

The `unlimitedApproval` toggle (`:30-31, 61`) does not address this — flipping from unlimited→exact still hits the USDT zero-check.

---

## M-03  [Vector 8]  No MEV / sandwich warning anywhere in the flow

**Files:** `frontend/src/pages/TradePage.tsx:228-294`, `frontend/src/hooks/useSwapQuote.ts`

The UI warns on `slippage >= 5%` ("High slippage tolerance — you may receive significantly less than quoted") and `priceImpact > 5%` ("High price impact!"), but never warns about **MEV / sandwich risk** on slippage between 1–5% with a large notional. CowSwap (one of the integrated aggregators) is explicitly MEV-protected — the UI has the data (`bestAggregatorName === 'CowSwap'`) but does not surface a "MEV-protected route" badge nor an inverse "Standard mempool route — consider increasing slippage / using CowSwap" hint when a non-protected aggregator is selected on a large trade.

The user-facing impact: the entire "Compare all routes" UI (`TradePage.tsx:354-384`) ranks purely on `amountOut` with no MEV-resistance dimension, so it can recommend a route that delivers 0.1% better quoted output but loses 2% to a sandwich.

---

## M-04  [Vector 7]  Custom-token import: lookup-by-`isImporting` runs `useReadContract` against any 40-hex blob the user pastes

**File:** `frontend/src/components/swap/TokenSelectModal.tsx:167-181`

`isImporting = isValidAddress(importAddress) && !allTokens.find(...)` — the only gate before sending `symbol()` and `decimals()` reads to the pasted address. There is no `code.length > 0` check, no `isContract` probe, no allowlist signal. Pasting an EOA returns `0x` for both reads (silent), but pasting a known **honeypot proxy** returns valid-looking values and the import flow happily progresses to the "I understand the risks" checkbox. The spoofed-symbol guard (`:196-203`) only blocks tokens that share a default-list **symbol** at a different address; it does not protect against:

- Lookalike symbols (USDC vs. USDᏟ Cherokee letter — passes `[^\x20-\x7E]` strip if it's been pre-Latinized).
- Tokens with malicious `transfer`/`approve` hooks (no bytecode probe; no warning that a custom token may have arbitrary `transferFrom` semantics).

Combined with M-02 (USDT-pattern revert), an attacker-deployed token with hostile approval semantics is one risk-checkbox away from a swap. The "Etherscan" deeplink (`:434-441`) is the user's only verification surface.

---

## M-05  [Vector 12]  Aggregator HTTP failures swallow ALL errors as `null` — user gets "no quote" with no diagnosis

**File:** `frontend/src/lib/aggregator.ts:35-256`

Every aggregator function ends in `} catch { return null; }` — network errors, JSON parse errors, 401/403, CORS preflight rejection, rate-limit (KyberSwap is 10 req / 10 s), proxy-misconfig errors, **all collapse to `null`**. The meta-aggregator (`:267-305`) collects `Promise.allSettled` results and only keeps fulfilled-non-null values. If all 7 fail (likely scenario: the proxy paths `/api/odos`, `/api/cow`, `/api/lifi`, `/api/kyber`, `/api/openocean`, `/api/paraswap` aren't configured in production Vite/Caddy/whatever, returning HTML 404 to JSON parse), the user simply sees "Best rate via Uniswap V2" with no indication that the aggregator comparison is silently broken. There is no error log, no Sentry capture, no toast, no console warning. **`useSwapQuote.ts:206-211`** also catches the rejection and silently sets `aggQuoteResult` to `null`. Operationally invisible.

Same pattern applies to `useSwapQuote.ts:224 (} catch {})` for `BigInt(aggQuoteResult.amountOut)` — invalid-string aggregator response is silently dropped.

## M-06  [Vector 12]  `useSwap` write-error effect drops the actual revert reason

**File:** `frontend/src/hooks/useSwap.ts:164-183`

`useEffect` on `writeError` calls `decodeRevertReason(writeError)` then `toast.error(msg)`. `decodeRevertReason` (`lib/revertDecoder.ts:27-58`) only matches against a curated list of strings. If the JSON-RPC node returns a custom error selector that is **not** in `KNOWN_ERRORS`, decoder returns the raw `message` (`:57`) — but for many wagmi errors `error.shortMessage` is `"Execution reverted for an unknown reason."` and `error.message` is verbose with the actual `data: 0x...` selector buried inside. The user sees the generic shortMessage; the 4-byte selector that would let a developer/Towelie debug it is not surfaced anywhere. No `console.error`, no telemetry call. Only the FoT auto-retry path (`:169-181`) actually inspects raw message.

---

## M-07  [Vector 7]  `addCustomToken` warning toast is the **only** trust signal post-import

**File:** `frontend/src/hooks/useSwap.ts:350-360`

After `handleImport` succeeds, `addCustomToken` fires a single 8-second toast warning. From that point on, the token persists in `localStorage` indefinitely and is rendered identically to verified tokens in: chips (TokenSelectModal.tsx:286-311 — actually filtered to default list, OK), recent pills (`:319-348` — "!" indicator IS shown, good), main list (`:393-394` — "Unverified" badge shown, good). Inside the swap card itself (`TradePage.tsx:174, 219`) the symbol is rendered with **no unverified indicator** — once selected, it looks like any other token. A user returning the next day will see "WBTC → USDC" in their swap card with no recall that "WBTC" was a fake token they imported. Suggest persistent `isCustom` flag on the swap card token-pill.

---

## M-08  [Vector 6]  `OpenOcean` decimals math truncates with `slice(0, 6)` — large amounts lose precision

**File:** `frontend/src/lib/aggregator.ts:199-228`

```ts
const humanAmount = whole.toString() + '.' + frac.toString().padStart(fromDecimals, '0').slice(0, 6);
```

Hard-codes 6 fractional digits in the human-readable amount sent to OpenOcean. For an 18-decimal token, this **drops 12 decimal places of input precision**. For a small swap (e.g. 0.00000123 ETH = 123 × 10⁻⁸), `slice(0, 6)` keeps `000001` and drops the `23`. Resulting OpenOcean quote is for `0.000001 ETH` rather than `0.00000123 ETH`. For very small amounts (1e-7 to 1e-12 of input token), the entire fractional part is replaced with zeros — OpenOcean returns a zero quote, gets dropped. For larger amounts (>1 unit) the loss is rounding noise, but the lower-bound case is silently broken. No fallback note in the code. `whole.toString()` for amounts > 2^53 is fine because BigInt-string, so the bug is only in the fractional truncation.

---

## L-01  [Vector 1]  Default slippage 1.0% is reasonable, but 20% max is still very generous

**File:** `frontend/src/hooks/useSwap.ts:36-43`

Default of 1.0% is fine. Max-20% is enforced (down from the prior 49% noted in the comment). 20% slippage on a 5 ETH swap is up to 1 ETH gifted to MEV; the warning at `>= 5%` is the only soft barrier (TradePage.tsx:290-294). Consider hard-blocking submit at `>= 15%` with an "I really want to lose money" double-confirm.

---

## L-02  [Vector 9]  ChainId guard IS present but inconsistent

**File:** `frontend/src/hooks/useSwap.ts:209`, vs. `useSwapAllowance.ts` (none)

`executeSwap` does check `if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }`. **Good.** But:
- `useSwapAllowance.approve()` (`:59-70`) has **no chainId guard**. If the user has switched to a wrong chain after fetching allowance and clicks "Approve", wagmi will dispatch the approve to whatever network the wallet is on, against the mainnet router address. Likely benign (no contract at that address on a testnet) but wastes gas with no UI feedback.
- `useSwapQuote.ts:71` correctly gates reads with `onRightChain`. **Good.**

Marking the missing-guard count as 0 in the table because the *primary* swap path is guarded. The approval gap is L.

---

## L-03  [Vector 11]  TOWELI symbol inside chip uses image with `alt=""` (good) but `swap.fromToken?.symbol` printed in `aria-label`

**File:** `frontend/src/pages/TradePage.tsx:169, 179, 214`

`aria-label={`Change token to pay with (currently ${swap.fromToken?.symbol ?? 'none selected'})`}` — for a custom token, the (post-sanitize) symbol reaches a screen-reader announcement. Already sanitized at import, so low risk. Consider also stripping zero-width characters to prevent SR confusion.

---

## L-04  [Vector 10]  `addCustomToken` debounce/idempotence is by address only

**File:** `frontend/src/hooks/useSwap.ts:356-360`

`if (prev.find(t => t.address.toLowerCase() === token.address.toLowerCase())) return prev;` — good for the same address. But pasting two **different** addresses with identical symbols (typical airdrop spoof technique) results in two persisted tokens with the same display symbol in the list. UI distinguishes via "Unverified" badge but not via address. A "you already have a token named X" warning would help. Low-impact.

---

## L-05  [Vector 11]  `decodeRevertReason` will return >150-char raw message — could include user-controlled data

**File:** `frontend/src/lib/revertDecoder.ts:49, 53-57`

If the on-chain revert string contains an attacker-controlled token symbol (e.g., "transferFrom failed for token <FAKE_USDC>"), the raw string is rendered in a `toast.error()` call. React-DOM safe (auto-escaped) and `<150` chars truncated, but Sonner toasts use `description` which goes into `dangerouslySetInnerHTML` for some themes. Verify Sonner version; if affected, sanitize the decoded reason.

---

## I-01  Aggregator API keys / proxy paths assumed live with no health check

**File:** `frontend/src/lib/aggregator.ts:75, 116, 151, 178, 216, 244`

Six of seven aggregators are accessed via relative `/api/<aggregator>/...` paths, implying server-side proxy. There is no UI surface (status pill, settings → "Aggregators online") indicating which are reachable. Combined with M-05, this means a misconfigured prod proxy results in a permanently degraded quote without any operator visibility. Add a one-time `OPTIONS` probe on app load and surface a "1 of 7 aggregators reachable" status.

## I-02  Tegridy preference of 0.15 % capped at quote level only

**File:** `frontend/src/hooks/useSwapQuote.ts:233-245`

Routing prefers Tegridy DEX with a **0.15% tolerance** (TEGRIDY_PREFERENCE_BPS = 15n). The label discloses "(preferred +0.15%)" (`:353`) — informationally honest. But if Uniswap output is, say, 0.10% better, Tegridy still wins; user pays 0.10% in opportunity cost, slippage envelope absorbs it silently. Defensible business policy if disclosed; the current label disclosure is sufficient.

## I-03  CowSwap is integrated but flagged `priceImpact: 0`

**File:** `frontend/src/lib/aggregator.ts:127-131`

Hard-coded `priceImpact: 0` for CowSwap (and Li.Fi `:159`, KyberSwap `:189`, ParaSwap `:252`). Downstream `priceImpact` math in `useSwapQuote.ts:274-331` only uses on-chain reserves anyway, so this hard-coded zero is never actually read for the active route — but `aggQuoteResult.priceImpact` is exported (`:53` in aggregator) and could be misread by a future consumer. Cosmetic / latent bug.

---

## Summary

- **3 High** (H-01 minOut UI/chain divergence on aggregator route, H-02 quote staleness, H-03 token symbol render gaps + H-04 spam-Swap race) — all directly user-fund-impacting.
- **8 Medium** (deadline default, USDT approve pattern, MEV warning gap, custom-token import gates, swallowed aggregator errors, swallowed write errors, OpenOcean truncation, persistent custom-token trust UX).
- **5 Low + 3 Info** — supporting concerns, telemetry gaps, label fidelity.

No emergency-class issues found in core swap submission path itself (the on-chain leg uses bigint slippage math correctly, deadlines are bounded, chainId is checked at submit). The dominant risk surface is the **UI-side divergence between displayed and submitted values** (H-01, H-03) and **operational invisibility of failures** (M-05, M-06, I-01).
