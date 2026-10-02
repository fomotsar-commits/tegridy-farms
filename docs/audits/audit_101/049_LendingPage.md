# Agent 049 — LendingPage / NFTLending / LendingSection / useMyLoans

**Targets**
- `frontend/src/pages/LendingPage.tsx`
- `frontend/src/components/nftfinance/NFTLendingSection.tsx`
- `frontend/src/components/nftfinance/LendingSection.tsx`
- `frontend/src/hooks/useMyLoans.ts`

**Counts**: 18 findings (4 HIGH · 7 MEDIUM · 5 LOW · 2 INFO)

---

## HIGH

### H-049-1 — Position value mis-rendered as 1:1 TOWELI->ETH (token-lending LTV is fake)
`LendingSection.tsx:1110-1112`
```tsx
<span className="...">Position Value</span>
<div className="font-mono ...">
  {formatTokenAmount(positionAmount)} ETH
</div>
```
`positionAmount` is `formatEther(position[0])` — the **TOWELI amount staked**, NOT the ETH value of that position. The label says "ETH" and it is then fed straight into `computeLTV(offer.principal, positionAmount)` (line 980), which computes `principalEth / pv * 100` treating TOWELI units as ETH. With TOWELI trading at, say, 0.0001 ETH, a 100,000 TOWELI position renders as "100,000 ETH" and LTV reads "near zero" — green checkmark. In reality the position is worth ~10 ETH and a 5 ETH loan is 50% LTV. **Borrower sees a wildly understated risk number; lender's "ETH floor" guard on the offer object is the only real safety, but the UI never compares against it.** This is the single biggest visual lie on the page.

### H-049-2 — ETH-floor mode is silently mis-rendered (rendered as wei-formatted ETH but never validated against position)
`LendingSection.tsx:999-1003`, `1062-1066`
```tsx
{offer.minPositionETHValue > 0n && (
  <div>+ {formatTokenAmount(formatEther(offer.minPositionETHValue))} ETH floor</div>
)}
```
The ETH-floor value is shown as a separate line item but the borrower's position is **never priced against it on the client**. The expanded detail only shows TOWELI amount and the bogus "Position Value" → ETH (see H-049-1). A borrower who passes the `minPositionValue` (TOWELI count) check but fails the on-chain `minPositionETHValue` check will get a generic revert with no preflight feedback. There is no `useTOWELIPrice` -based preview comparing `position.amount * twap` vs `offer.minPositionETHValue`, despite `useTOWELIPrice()` being imported (line 15) and `ethUsd` being used elsewhere in `LendTab` for a USD estimate.

### H-049-3 — `repayLoan` fee included in `value` is stale (interest accrual not refreshed before tx)
`NFTLendingSection.tsx:909-916, 932-944` and `LendingSection.tsx:1453-1494`
`getRepaymentAmount` is read with `useReadContract` with **no `refetchInterval`** in the NFT path and no `refetchInterval` in the token path either. wagmi's default `staleTime` will hold the value cached. Because pro-rata interest is `principal * apr * (now - startTime) / year`, the repayment number visible to the borrower lags real time. When they click Repay 30+ seconds later, the `value: repaymentData` sent with the tx is **less than current `getRepaymentAmount(loanId)`**, the contract reverts with "InsufficientPayment" (or worse, partial-pay), and the user gets a wallet-level revert instead of a UI-side recompute. Compare with `useCountdown` (line 95) which polls every 1 s — the visual countdown ticks but the dollar number doesn't. After repay, `repaySuccess` toast fires but the loan list doesn't refetch (wagmi cache invalidation is not configured for any of these reads).

### H-049-4 — Deadline countdown uses local clock (timezone-correct but drift-vulnerable; "default countdown" visible to lender, not to borrower the same way)
`LendingSection.tsx:95-108, 1528-1545`, `NFTLendingSection.tsx:82-85, 905-907, 955-963`
Two parallel countdown implementations:
1. `useCountdown` in LendingSection ticks every 1 s using `Date.now()` — works in UTC seconds so timezone is fine, but if the user's clock is off (NTP-drifted laptop, mobile in airplane mode), the deadline clock can show "Expired" while the chain still shows active, **or worse, show 2 hours remaining when the chain has already crossed the deadline** — a borrower may click Repay and revert. There is no fallback to chain timestamp (`useBlock` etc.).
2. NFTLendingSection's `LoanCard` does the same thing inline (lines 905-907, 955-963) but does **not** auto-tick — it only re-evaluates `Math.floor(Date.now()/1000)` on render. A borrower viewing their card never sees the countdown move; a stale value shows "1d 4h" indefinitely until React re-renders. **The lender's `Claim Default` button is gated on `status === 'overdue'` computed from the same stale `now`, meaning the button can stay disabled past the actual deadline OR enable prematurely.**
Additionally, **borrower's view shows the same countdown UI as lender's** (LendingSection line 1528-1545 — both roles show countdown). But `NFTLendingSection` shows the deadline only when `status === 'active' || 'overdue'` (line 1011) — repaid/defaulted hides it. A lender viewing a freshly-overdue loan sees "OVERDUE" + Claim button; a borrower in the same state sees "OVERDUE" but Repay disabled (because `status === 'active'` gate line 1039). The default-claim window is therefore visible to the lender but the repay action is **not** visible to the borrower at the same moment — they must reload to see the asymmetry. Confirmed via lines 1039-1062: borrower-repay only shows for `'active'`, lender-claim only shows for `'overdue'`. There is no grace period rendered.

---

## MEDIUM

### M-049-1 — Missing chainId guard
None of the four files import or check `useChainId()` from wagmi. A user connected to mainnet would see contract reads return undefined silently (`useReadContract` resolves to `undefined` on wrong-chain), the "Total Offers: 0" stat would render normally, and clicking "Create Offer" would issue the tx against whatever chain the wallet is on. The deployed-check (`isDeployed(TEGRIDY_LENDING_ADDRESS)`) only checks that the constant is non-zero in the env; it doesn't verify the user is on the chain that deployed the contract.

### M-049-2 — Missing pause-state check
Both `TEGRIDY_LENDING_ABI` and `TEGRIDY_NFT_LENDING_ABI` typically expose a `paused()` view (Pausable from OpenZeppelin); neither file reads it. If the protocol pauses, the user sees a fully-functional UI, clicks Create Offer / Accept / Repay, and gets a generic "Pausable: paused" wallet-side revert. There is no pause banner, no disabled button state. NFTLending offer creation does not even have a `deployed` gate — it sends the tx regardless.

### M-049-3 — Oracle-staleness not surfaced to user
The token-lending offer's `minPositionETHValue` is enforced on-chain via TOWELI/ETH oracle (likely the staking pool TWAP). The frontend fetches `useTOWELIPrice()` (line 15) but never displays the price's age, the oracle's last-updated timestamp, or warns the user when the TWAP is stale. The "USD estimate" uses `ethUsd` blindly. If the oracle is paused/stale, the borrower sees a green "Accept Offer" button and gets a contract-side revert with no preflight diagnostic.

### M-049-4 — Borrow-amount confirm shows different number than what gets submitted
`NFTLendingSection.tsx:288-294` (LendTab.handleCreateOffer):
```tsx
args: [parseEther(principal), BigInt(aprBps), BigInt(duration), selectedCollection, tokenIdBig],
value: parseEther(principal),
```
The principal is `parseEther(principal)` where `principal` is the raw input string. **No rounding/truncation guard.** A user typing `0.10000000000000001` (more than 18 decimals) hits viem's parser; it may throw OR silently truncate. The TxSummary preview displays `{principal} ETH` raw — what shows in the confirm card is exactly the user input string, but what gets sent could differ by rounding. Same on `LendingSection.tsx:680-714` — `parseEther(principal)` is sent twice (as value + arg) but the confirm summary on line 850-852 shows the unparsed string. Edge: leading-zero decimals like `00.5` could pass `parseFloat` validation but parseEther accepts a slightly different lexeme.

### M-049-5 — Partial-repay not surfaced (allowed by contract but not visible)
The repay button (`NFTLendingSection.tsx:1041-1051`, `LendingSection.tsx:1556-1562`) is hardcoded to send `value: repaymentData` (full repayment). If the underlying contract supports partial repay (the `repayLoan` ABI may take a `value` ≤ full amount and apply to interest first), there is no UI to enter a partial amount. There is also no banner that says "partial repay disabled by contract" — the user just doesn't see the option. Silent feature drop.

### M-049-6 — NFT collateral image fetched from external URL with no fallback
`NFTLendingSection.tsx:15-19`:
```tsx
const COLLECTION_ART: Record<string, string> = {
  JBAC: ART.jbacSkeleton.src,
  NAKA: '/splash/skeleton.jpg',
  GNSS: '/collections/gnssart.jpg',
};
```
`/splash/skeleton.jpg` and `/collections/gnssart.jpg` are public-folder paths. The `<img>` tags on lines 320, 557 have no `onError` handler — if the asset 404s or the CDN returns a wrong content-type, the Borrow card shows a broken image icon next to "Required Collateral" and there's no graceful fallback to a generic placeholder or the contract address. The `LoanCard` on line 1005 of NFTLendingSection just shows tokenId number but **never fetches and displays the actual NFT metadata image** — borrower can't visually confirm which token they are repaying for. For a high-value NFT collateral page, this is a UX/security gap (no visual anti-spoof confirmation that you're repaying for the same token you collateralized).

### M-049-7 — `useMyLoans.ts` indexes loans 0..n-1 but contracts mostly use 1..n
`useMyLoans.ts:62-67, 75-80`:
```tsx
Array.from({ length: tokenCount }, (_, i) => ({
  ...
  args: [BigInt(i)] as const,
}))
```
Loans are queried with `id = 0, 1, ..., count-1`. But `NFTLendingSection.tsx:818-825` uses `BigInt(i + 1)`:
```tsx
Array.from({ length: loanCount }, (_, i) => ({
  ...
  args: [BigInt(i + 1)] as const,
}))
```
Same for `LendingSection.tsx:1729-1734` which uses `BigInt(i)` (0-indexed). The two loan tables produce different ID sets. If `getLoan(0)` reverts on the NFT contract because IDs start at 1, half of `useMyLoans` returns `{status: 'failure'}` and the loans are silently dropped from the dashboard — borrower's outstanding loans don't appear in the global list while still appearing in NFTLending's "My Loans" tab. This is a data-consistency divergence between the two views.

---

## LOW

### L-049-1 — `LendingPage.tsx` derives initial section from `searchParams` but localStorage `INTRO_DISMISSED_KEY` parse is unsafe under SSR (line 77 `localStorage.getItem`); no fallback noted.
### L-049-2 — `void useAccount()` (NFTLendingSection line 101) is a code smell; if the hook removes context-required behavior the comment "keep wagmi context alive" silently breaks.
### L-049-3 — Currency math uses `parseFloat(formatEther(...))` (e.g. line 1145, 1146 of LendingSection, 759 of NFTLendingSection). For very large principals this loses precision — repayment preview shown to user may differ from contract's bigint math by a few wei. Not exploitable, but visible as confusing rounding.
### L-049-4 — `getLoanStatus` in NFTLendingSection (line 79-85) does not consider the `repaid` AND `defaultClaimed` simultaneously edge case (both true). If the contract ever sets both, the status returns 'repaid' first; UI never surfaces the "weird state" to the user.
### L-049-5 — `useReadContracts` for offer/loan batches has no `refetchInterval` (LendingSection lines 1686-1689, 1737-1740, NFTLendingSection lines 482-484, 828-830). Stats stay stale until the user changes tabs or wagmi natural-refetches. The `useMyLoans` hook DOES set `refetchInterval: 30_000` — inconsistency between mounts.

---

## INFO

### I-049-1 — Two duplicate `getLoanStatus` implementations (NFTLendingSection line 79, LendingSection line 87) with identical logic but different module scope. Should be hoisted to a shared lib.
### I-049-2 — `LendingPage` deep-links via `?section=` but doesn't validate that the connected chain has the lending contract deployed — clicking the "NFT Lending" intro card on a non-supported chain still routes there; the user sees a header and an empty "Connect wallet to view your loans" instead of a "wrong chain" warning.

---

## TOP-3 PRIORITY

1. **H-049-1**: LTV ratio is computed against TOWELI amount labeled as ETH — the entire risk indicator on the Borrow tab is wrong for any TOWELI:ETH ratio ≠ 1.0. Borrowers may take loans they think are 30% LTV that are actually 200% LTV.
2. **H-049-3**: `repaymentAmount` cached without `refetchInterval` — borrower's repay tx routinely sends stale `value`, contract reverts. Combined with no post-tx refetch, the loan list also doesn't update after a successful repay.
3. **H-049-4**: Two countdown systems (LendingSection ticks every 1 s; NFTLendingSection re-evaluates only on render). NFT path borrowers see frozen countdowns; lender's Claim Default button enables on local-clock drift, racing the borrower whose Repay button is hidden.
