# Agent 050 — PremiumPage / usePremiumAccess Audit

**Targets**:
- `frontend/src/pages/PremiumPage.tsx` (449 lines)
- `frontend/src/hooks/usePremiumAccess.ts` (206 lines)

**Scope**: client-side gating, expiry/timezone drift, signature/localStorage tokens, refresh re-grants, FoP-content flash, UI-only payment confirmation, missing chainId/nonce on SIWE-derived sessions.

---

## Hunt-list summary

| # | Hunt item | Status | Severity |
|---|-----------|--------|----------|
| 1 | Client-only gating bypassable via devtools | CONFIRMED — but content is non-sensitive | INFO |
| 2 | Expiry timezone drift | CLEAN | — |
| 3 | Signature tokens in localStorage with no expiry | CLEAN (no localStorage usage on this page) | — |
| 4 | Refresh logic that re-grants access | CLEAN | — |
| 5 | Race between expiry check and tx | LOW | LOW |
| 6 | Paywall flash (premium content rendered first) | NOT APPLICABLE (page does not render gated content) | — |
| 7 | Payment confirmation UI-only without on-chain verification | CLEAN — uses `useWaitForTransactionReceipt` + reads `hasPremium` from chain | — |
| 8 | Missing chainId/nonce on SIWE session | NOT APPLICABLE (no SIWE on this page) | — |
| 9 | Wrong ABI used for JBAC NFT balance lookup | CONFIRMED | INFO |
| 10 | Stale `monthlyFee` causing under-approval / failed subscribe | CONFIRMED | LOW |
| 11 | `useEffect` setTimeout(0) chain on success may double-toast | LOW | LOW |
| 12 | No max-cost cap on `approveToweli` matches subscribe `maxCost` semantics | INFO | INFO |

**Counts**: HIGH 0 · MEDIUM 0 · LOW 3 · INFO 3

---

## Findings

### F-050-01 (INFO) — Client-only gating display only; no sensitive content gated
**Loc**: `PremiumPage.tsx:134-153, 201, 425`
**What**: `premium.hasPremium` from `useReadContract` drives display of "GOLD CARD ACTIVE" banner, hides plan picker, and shows JBAC activate button. A user can flip `hasPremium` to true via devtools/React inspector or by patching the wagmi cache.
**Impact**: Cosmetic only — there is **no premium content rendered on this page**. All real benefits (3x points, fee discount, revenue share) are enforced **on-chain** by the respective contracts:
- Fee discount: `TegridyFeeHook` reads on-chain
- Revenue share / staking: contract enforces eligibility
- 3x points: enforced by points contract

There is no JWT, no API endpoint, no off-chain content unlock. Bypass yields no real benefit.
**Recommendation**: Document this in code comment so future devs don't add API-fetched premium content keyed off `hasPremium` without server-side re-check.

### F-050-02 (LOW) — Race between stale `monthlyFee` and `subscribe` maxCost
**Loc**: `usePremiumAccess.ts:93-103`, `PremiumPage.tsx:62-67`
**What**: `subscribe(months)` computes `maxCost = monthlyFee * months` from cached read, then sends as the on-chain frontrun guard. If admin updates `monthlyFeeToweli` between the cache `refetchInterval: 30_000` boundary and the user's tx, three outcomes:
1. New fee > cached: tx reverts via `maxCost` check (good — H-02 fix works).
2. New fee < cached: user pays the new (lower) fee but pre-approved the old (higher) total — leaves residual allowance dangling.
3. User saw discount math `monthlyFee * months * (100-discount) / 100` in UI (line 62-64 of PremiumPage) but `subscribe` sends `monthlyFee * months` (no discount factored). UI shows e.g. "70 TOWELI" for 1y/30%, but on-chain `maxCost` arg is the full `monthlyFee * 12`. The contract presumably applies the discount — but `maxCost` is the **ceiling**, so if contract charges full price the tx still passes. **Discount enforcement happens on-chain only.**
**Impact**: Low. The maxCost is correctly the upper bound. But user may be confused if displayed cost ≠ wallet-popup amount.
**Recommendation**: Either pass the discounted `maxCost` (matching displayed total), or add a tooltip that wallet popup shows worst-case ceiling.

### F-050-03 (LOW) — Race between expiry boundary and `subscribe` re-up
**Loc**: `usePremiumAccess.ts:73-75`
**What**: `daysRemaining` derived from `Date.now() / 1000` vs `expiresAt`. If user is at `daysRemaining === 1`, they may click subscribe and the on-chain block.timestamp may be such that the contract treats their existing sub as "expired" or "still active" inconsistently with what the UI shows. The UI does not check or warn about a renewal-vs-new-purchase boundary.
**Impact**: Low — depends on contract logic. If contract extends the existing expiry from now or from old expiry differs, user could lose accumulated days.
**Recommendation**: UI should query contract behavior and clarify "extending existing" vs "starting fresh" before tx.

### F-050-04 (INFO) — Wrong ABI for JBAC NFT balance read
**Loc**: `usePremiumAccess.ts:28-34`
**What**: `useReadContract({ address: JBAC_NFT_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] })`. JBAC is an ERC-721 NFT. ERC-20 and ERC-721 share `balanceOf(address) -> uint256` selector, so this works at runtime, but ABI typing is incorrect.
**Impact**: Functional, but if JBAC ever migrates to ERC-1155 or a custom NFT, this silently breaks. Also misleading for code review.
**Recommendation**: Use a dedicated `ERC721_ABI` or minimal `[{name: 'balanceOf', inputs: [{type: 'address'}], outputs: [{type: 'uint256'}], type: 'function', stateMutability: 'view'}]`.

### F-050-05 (LOW) — `setTimeout(0)` reset chain may swallow rapid double-success or double-toast on prop churn
**Loc**: `usePremiumAccess.ts:114-147`
**What**: 4 separate `useEffect` hooks each schedule `setTimeout(() => reset(), 0)` with deps that include the `reset*` fn references. wagmi v2 may re-create writeContract refs across re-renders. If `isApproveSuccess` flips true → false (via reset) → true (re-fired) within a single tick, two toasts may fire. Conversely, the deferred reset means consumers of `isApproveSuccess` see it true for one extra render cycle — intentional per the comment, but adds surface.
**Impact**: Low — at worst duplicate toast.
**Recommendation**: Consider a single `lastHandledHash` ref to gate toast firing per tx hash.

### F-050-06 (INFO) — Payment confirmation correctly uses on-chain receipt + cache invalidation
**Loc**: `usePremiumAccess.ts:19-25, 115-131`
**Status**: **Clean**. Subscription state comes from `hasPremium`/`getSubscription` reads, not from tx-success UI flag. After tx confirms, `refetch()` re-pulls on-chain truth. No purely-UI-side "you have premium now" deception possible.

### F-050-07 (CLEAN) — No localStorage / sessionStorage / signed cookie usage
**Loc**: entire file scan
**Result**: 0 matches for `localStorage`, `sessionStorage`, `cookie`, JWT, signature-based session. Page is fully on-chain reads + writes via wagmi. SIWE/`api/auth/me` is unrelated to premium gating here.

### F-050-08 (CLEAN) — chainId guard on writes
**Loc**: `usePremiumAccess.ts:83, 94, 106`
**Result**: All three write functions (`approveToweli`, `subscribe`, `activateNFTPremium`) check `chainId !== CHAIN_ID` and toast-error before writing. Reads via `useReadContracts` will simply return errors on wrong chain (handled by isDataError). Good.

### F-050-09 (CLEAN) — No paywall flash
**Result**: No premium-only content rendered on this page. Page is the marketing/subscribe page itself. Status banner conditional on `hasPremium` is cosmetic and renders at the same time as the rest.

### F-050-10 (CLEAN) — Refresh logic
**Loc**: `usePremiumAccess.ts:50, 118, 127`
**Result**: `refetch()` triggers re-read of on-chain state. Cannot grant access; only re-mirrors chain truth.

---

## Cross-check: api/auth/siwe.js + me.js

PremiumPage and usePremiumAccess do **not** call any auth/me/siwe endpoint, do not import API session helpers, and do not store any signed token. Premium status is read directly from `PREMIUM_ACCESS_ADDRESS` contract. Scope-cross item N/A.

---

## Verdict

**Overall**: Hardened. No HIGH/MED. Premium gating is correctly enforced on-chain via `PremiumAccess` contract reads + writes with `maxCost` frontrun protection (audit fix H-02 confirmed in code). Devtools "bypass" yields no actual benefit because all benefits (fee discount, revenue share, points multiplier) are enforced by their respective on-chain contracts, not by frontend reading `hasPremium`.

**Polish items**: ABI typing, discount-vs-maxCost UX clarity, expiry boundary UX, double-toast race.
