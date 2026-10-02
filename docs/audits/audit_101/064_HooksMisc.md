# Agent 064 — Frontend Hooks (Misc) Forensic Audit

**Scope**: `useAddLiquidity.ts`, `useIrysUpload.ts`, `useMyLoans.ts`, `useNetworkCheck.ts`, `usePageTitle.ts`, `useTransactionReceipt.ts`, `useWizardPersist.ts`, `useAutoReset.ts`, `useConfetti.ts`
**Mode**: AUDIT-ONLY — no code changes.
**Date**: 2026-04-25

---

## Counts

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 3 |
| MEDIUM   | 6 |
| LOW      | 5 |
| INFO     | 4 |
| **Total**| **18** |

---

## HIGH

### H1 — `useMyLoans.ts`: Unbounded pagination — fetches ALL loans ever created (DoS / RPC bomb)
**File**: `frontend/src/hooks/useMyLoans.ts:59-93`
```ts
const tokenContracts = useMemo(
  () =>
    tokenDeployed && tokenCount > 0
      ? Array.from({ length: tokenCount }, (_, i) => ({
          ...,
          functionName: 'getLoan' as const,
          args: [BigInt(i)] as const,
        }))
      : [],
  [tokenDeployed, tokenCount],
);
```
The hook reads `loanCount()` and then fans out a `useReadContracts` multicall with one entry **per loan ID from 0 to loanCount**, on BOTH `TegridyLending` and `TegridyNFTLending`. There is no upper bound, no pagination, no slicing.

Once the protocol scales to ~1k+ loans the user's wallet will issue a multicall payload with 2× loanCount sub-calls **every 30 seconds** (`refetchInterval: 30_000`). Public RPCs will rate-limit / drop the response, the multicall contract has a gas-budget ceiling (~30M) that will be exceeded, and even when it succeeds the `outstanding` `useMemo` will iterate every loan and run a string compare every time.

**Impact**: dApp frontend becomes unusable for *all* users once `loanCount` grows large; no individual user can "opt out" because everyone shares the same global counter. Worse, this happens *quietly* — it'll just stop showing loans without an error toast.

**Recommendation**: paginate with a chunk size (e.g. last 200 IDs), or add an indexer-backed `loansForAddress(user)` view function on the lending contracts.

---

### H2 — `useIrysUpload.ts`: NO size cap on uploads — wallet drainer / accidental funding
**File**: `frontend/src/hooks/useIrysUpload.ts:106-156`, `:170-209`

The hook accepts `File[]` and `items: { filename, json }[]` from callers and uploads each to Irys without any size validation:
- No max-file-size check.
- No max-total-size check.
- No max-file-count check.
- `quote()` returns price for arbitrary `totalBytes` and `fund()` will drain the wallet for whatever the caller passes.

A malicious launchpad wizard URL (or a poisoned CSV import on the same wizard) could cause the hook to:
1. Build a 1GB blob from CSV-parsed metadata.
2. Quote ~1GB worth of Irys fees (could be tens of $).
3. Auto-fund the Irys node from the connected wallet because the wizard plumbing calls `fund(amountWei)` with whatever quote returned.

There is also no caller-side validation in `useWizardPersist` of `csvText` length — the persisted draft can grow unbounded into localStorage too (linked).

**Impact**: a user pasting a malicious / accidentally-huge CSV can be silently quoted into funding a multi-dollar Irys top-up. No "are you sure?" prompt. The fact that fund txs are real on-chain ETH txns means the wallet will prompt — but the **quote**ing UI doesn't show "this is bigger than expected", and a confused user clicks through.

**Recommendation**: add `MAX_FILE_BYTES = 25 * 1024 * 1024` and `MAX_TOTAL_BYTES = 200 * 1024 * 1024` as hook-level constants and throw before `getPrice` is called. Also enforce per-file MIME allowlist against `f.type`.

---

### H3 — `useTransactionReceipt.ts`: NO reorg / re-confirmation handling; receipt is purely client-state
**File**: `frontend/src/hooks/useTransactionReceipt.ts:1-78`

`useTransactionReceipt()` is a context-only hook that holds `ReceiptData | null` in `useState` — it never calls `useWaitForTransactionReceipt` and never queries the chain. The "receipt" is whatever the upstream caller passed into `showReceipt({...})` *optimistically*, including `txHash`.

If the tx is dropped, replaced (speed-up / cancel from MetaMask), or reorg'd out, the UI continues to claim "Liquidity added" or "Swap confirmed" based on stale optimistic state. There is no `confirmations` count, no tx-status polling, no reconciliation against the actual receipt.

The naming (`useTransactionReceipt`, `ReceiptData`) is actively misleading — readers will assume this is sourced from the chain. It is not.

**Impact**: a user whose tx was front-run / replaced / orphaned sees a "success!" receipt and can act on a state that never landed. Combined with auto-clear toasts in `useAddLiquidity:146` (4-second `setTimeout(reset)`), there's no after-the-fact way to verify what happened.

**Recommendation**: rename to `useTransactionReceiptModal` (UI-only), and have the modal *itself* poll `useWaitForTransactionReceipt({ hash, confirmations: 2 })` on the captured `txHash` to display a live status ribbon. Treat `>0 reorg detected` as an explicit error state.

---

## MEDIUM

### M1 — `useAddLiquidity.ts`: Slippage default of 0.5% (50 bps) is far too tight for low-liquidity pairs
**File**: `frontend/src/hooks/useAddLiquidity.ts:209` (`slippageBps = 50`), `:251`
For a fresh launchpad token with thin reserves, 0.5% min-amount tolerance will revert nearly every add-liquidity tx after a single front-run. Worse, callers don't see the default in the function signature when wiring up — the UI may not pass `slippageBps` at all. Recommend dynamic default keyed off pool TVL: `< 10k ⇒ 200 bps; < 100k ⇒ 100 bps; else 50 bps`. Also note: there's no UI-side warning if the user picks `slippageBps > 500` (5%) which would be a sandwich invitation.

### M2 — `useAddLiquidity.ts`: `getAmountB`/`getAmountA` use SPOT reserve ratio for UI, used by router as `amountAMin`/`amountBMin` floor — sandwich window
**File**: `frontend/src/hooks/useAddLiquidity.ts:97-119`, `:233-243`
The hook computes `amountAMin = amountAWei * (10000-slippageBps)/10000` based purely on the user-typed wei. That part is fine. **However**, `getAmountB(amountA)` displays an "expected paired amount" (line 101: `amt * reserveB / reserveA`) using the spot reserves at the moment of fetch (refetched every 30s). The user types one side, sees a paired side, accepts, and the tx submits with both sides locked. An attacker can sandwich by skewing reserves *between* the user's read and submit, so `addLiquidity` either reverts (router rejects on min) or, if user dialed up slippage, mints fewer LP tokens against worse rates. This is the classic "spot-as-oracle" sandwich on the *display* path. Compare against TWAP (`TegridyTWAP.sol`) — the hook should use 1h-TWAP for the displayed paired amount, not raw `getReserves()`. (NB: this is a UX/correctness issue, not a contract bug — the router's invariant is sound.)

### M3 — `useNetworkCheck.ts`: Race condition during chain-switch — flashes "wrong network" mid-switch
**File**: `frontend/src/hooks/useNetworkCheck.ts:1-8`
```ts
const isWrongNetwork = isConnected && chain?.id !== CHAIN_ID;
```
During a wagmi chain switch (`switchChain`), there's a window where `isConnected===true` but `chain` momentarily becomes `undefined` (between disconnect and reconnect). With the strict `!==` and `?.id`, `undefined !== CHAIN_ID` evaluates true → the user sees a "wrong network" banner pop for 200-800ms during legitimate switches. Also: when wagmi is *reconnecting* on page load, `isConnected` flips true before `chain` populates → false-positive. Recommend: `chain && chain.id !== CHAIN_ID` (only flag if we actually know the chain) and gate on `isReconnecting === false`.

### M4 — `useWizardPersist.ts`: Persists across users — no wallet-address namespacing
**File**: `frontend/src/hooks/useWizardPersist.ts:4` (`STORAGE_KEY = 'tegridy:launchpad:draft'`)
The localStorage key is global across all wallets that use the same browser profile. If User A starts a wizard draft (collection name, description, mint price, **deployedAddress**, **fundTxId**, **deployTxHash**), then User B logs in later (same browser, different wallet), User B sees A's half-finished collection and can hit "continue" — including the `fundTxId` and `deployedAddress` that were paid for by A. While B can't *steal* A's contract (it's on-chain owned by A), B can submit on-chain operations against it, and worse, B's UI will "succeed" against a contract that B doesn't own.

PII concern: `description` and `externalLink` may contain identifying info. They're persisted in plain localStorage, which is readable by *every* script on the origin (including any future malicious extension or XSS). Recommend keying as `tegridy:launchpad:draft:${address.toLowerCase()}` and clearing on `useEffect([address])` change.

### M5 — `useWizardPersist.ts`: No max-size guard on draft serialization
**File**: `frontend/src/hooks/useWizardPersist.ts:74-91`
`csvText` (5,555 token CSVs at ~150 bytes/row ≈ 800kB) plus `validationWarnings` array gets `JSON.stringify`'d every 500ms. At ~5MB localStorage caps this can hit `QuotaExceededError` and fail silently (line 84: `catch {}`). The user gets no feedback that the draft isn't being saved. Recommend a 2MB pre-stringify size check + an explicit "draft too large to autosave" UI banner.

### M6 — `useIrysUpload.ts`: `window.ethereum` provider used directly — bypasses wagmi connector and account-permission checks
**File**: `frontend/src/lib/irysClient.ts:18-30`
The Irys uploader is built off raw `window.ethereum` rather than the `wagmi` walletClient. This means: (a) on WalletConnect/Coinbase Smart Wallet flows where there is no `window.ethereum`, the hook errors with a confusing message (line 19); (b) when the user has multiple wallets injected (MM + Rabby + Phantom EVM), the EIP-6963 selection is *ignored* — Irys talks to whichever wallet won the `window.ethereum` race; (c) Irys could end up funded from a different wallet than the one wagmi shows as "connected". This is an account-confusion footgun. Recommend deriving the Irys provider from `wagmi.useWalletClient()` and converting to ethers via `walletClientToSigner()`.

---

## LOW

### L1 — `useAddLiquidity.ts`: Toast `id: 'write-error'` is not unique — concurrent failures collide
**File**: `frontend/src/hooks/useAddLiquidity.ts:159`
If two write errors fire (e.g. user retries quickly), the second toast replaces the first under the same id. Use `${Date.now()}-write-error` or include the `tokenA.symbol` in the id.

### L2 — `useConfetti.ts`: `setTimeout(... 4000)` cleanup never cancelled — leak on rapid fire
**File**: `frontend/src/hooks/useConfetti.ts:132-135`
Each `fireConfetti` call schedules a 4s safety-clear `setTimeout` but never returns / clears it. If the user fires confetti 10× in 4 seconds, 10 timers race to clear the canvas; all but the last one trample legitimate later animations. Also, `requestAnimationFrame(draw)` keeps a closure over `particles` — if `fireConfetti` is called again while a previous run is still alive, you get two competing rAF loops drawing on the same canvas. Recommend a module-level `currentAnimId` that's cancelled before starting a new run.

### L3 — `useWizardPersist.ts`: `quoteWei` is not validated on read
**File**: `frontend/src/hooks/useWizardPersist.ts:97-107`
`readDraft` returns `quoteWei: string | null` and the wizard reducer presumably does `BigInt(quoteWei)` somewhere — but if a stored draft has been hand-edited in DevTools (e.g. `"banana"`), `BigInt("banana")` throws a SyntaxError that isn't caught here. Add a try/catch around the BigInt cast in the consumer or zero it out on parse failure.

### L4 — `useAutoReset.ts`: Setter identity changes re-trigger timer — confusing for inline-arrow callers
**File**: `frontend/src/hooks/useAutoReset.ts:13-17`
The dep array includes `setter`, so callers passing inline `(v) => ...` arrows will *reset the timer on every render* (new function identity each render). That means the auto-dismiss only ever fires after a render-quiet 5s window — for a busy parent, dismissal can be deferred indefinitely. Either drop `setter` from the deps with an `eslint-disable` (preferred — setters are stable) or document that callers must `useCallback` their setter.

### L5 — `usePageTitle.ts`: Unmount sets title back to `BASE_TITLE`, but only the *first* hook to unmount wins
**File**: `frontend/src/hooks/usePageTitle.ts:58`
If two routes mount `usePageTitle` (e.g. modal over page), unmounting the modal resets to "Tegridy Farms" overwriting the page-level title until the page hook re-runs. Minor cosmetic flicker. Recommend a small ref-counted title stack in a context, or just `document.title = pageTitle` with no cleanup (the next mount wins).

---

## INFO

### I1 — `useConfetti.ts`: Confetti is fire-on-demand only — does not auto-start mid-flow
The hunt-list flagged "useConfetti starting before user finishes flow"; reviewed all `fire()` callers and they're explicit user-success triggers. **No issue found here.** Marking INFO so future audits don't re-flag it.

### I2 — `useTransactionReceipt.ts`: `ReceiptData.data` is a giant union; no discriminated narrowing
The single `data: { fromToken?, ..., epoch?, ... }` union with all-optional fields means callers can pass a `'swap'` type with `bountyTitle` set and TS won't complain. Refactor to a discriminated union keyed on `type`. Cosmetic.

### I3 — `useMyLoans.ts`: Time check `now > deadline` uses client clock
Line 113, 137: status flag relies on `Date.now()` for "overdue" — a user with a wrong system clock will see incorrect overdue badges. Display-only impact, but flag.

### I4 — `useIrysUpload.ts`: `Buffer` polyfill via cast `as unknown as Buffer`
Lines 127, 144, 161, 181, 197 — relies on Vite's runtime Buffer polyfill. If the polyfill is ever stripped (tree-shake / vite version bump), the casts compile fine but explode at runtime. Add a smoke test that calls `uploadJson({})` against a mock Irys instance.

---

## Top-3 (most material)

1. **H1 — `useMyLoans.ts` unbounded pagination.** Will silently break the loans page for every user once the lending protocol scales past ~hundreds of loans. RPC + multicall gas ceilings are hard limits.
2. **H2 — `useIrysUpload.ts` no size cap.** Wallet-drain pathway via malicious / accidentally-huge wizard payloads. No upper bound on bytes quoted/funded.
3. **H3 — `useTransactionReceipt.ts` ignores reorgs.** "Receipt" UI is pure optimistic client state — claims success even when the tx never landed. Misleading hook name encourages wrong assumptions across the codebase.
