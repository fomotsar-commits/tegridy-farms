# TegridyNativeBuyRouter — design + security spec

**Status: DRAFT, audit-gated. Not deploy-ready.** Reference contract:
`contracts/src/TegridyNativeBuyRouter.sol`. It has not been compiled (local
`forge build` hangs — CI is the compile source of truth), fork-tested, or
audited. It handles user funds in the NFT buy path. Gate every deploy behind:
(1) clean CI compile, (2) a mainnet-fork suite that buys a native listing **and**
an OpenSea listing through it and asserts NFT delivery + referral credit, (3) a
full external audit.

## Why it exists (the unlock)
The protocol can monetize **token swaps** (SwapFeeRouter + ReferralSplitter sit in
the swap path), but the flow that actually exists is **NFT buys**, and those go
**direct to Seaport** — there is no router in the path to call
`ReferralSplitter.recordFee` or attribute a referrer. The native 1% fee (captured
today by the merge tie-break, commit `8bc12ab`) is a fixed Seaport consideration
to the treasury; it can't be split to a referrer at fulfillment.

This router is the minimal missing piece: a thin wrapper the **native** buy routes
through so the platform fee can be attributed to the buyer's referrer.

## Economic model (zero extra cost to the buyer)
- A **native** listing already makes the buyer pay `price` = `sellerReceives (99%)`
  + `platformFee (1%)`. Today the 1% goes straight to `PLATFORM_FEE_RECIPIENT`.
- With the router: new native listings name **the router** as the 1% fee
  consideration's `recipient`. The buyer fulfils **through the router**, paying the
  **identical `price`**. Seaport delivers the NFT to the buyer, 99% to the seller,
  and the 1% to the router. The router forwards that 1% to
  `ReferralSplitter.recordFee(buyer)` → the buyer's referrer gets their share
  (`referralFeeBps`, e.g. 10% of the 1%), the remainder returns to the router as
  caller-credit and is swept to treasury.
- Net: buyer pays the same; treasury gets ~90% of the 1%; referrer gets ~10% of the
  1%. The referrer cut is funded **out of** the existing fee, not added on top.

## Flow
```
buyer ──buy{value: price}(order, hash)──▶ Router
  Router.fulfillAdvancedOrder{value: price}(order, [], conduitKey, recipient = buyer)
      └▶ Seaport: NFT ─▶ buyer · 99% ─▶ seller · 1% ─▶ Router
  Router.recordFee{value: 1%}(buyer)   (best-effort)
      └▶ ReferralSplitter: referrerShare ─▶ pendingETH[referrer] · remainder ─▶ callerCredit[Router]
  (later) Router.sweepToTreasury() ─▶ withdrawCallerCredit + send ─▶ treasury
```
OpenSea / any order that pays **no** fee to the router → `fee == 0` → recordFee
skipped → pure pass-through (NFT → buyer, exact ETH forwarded). Routing such orders
through the router only wastes gas, so the **frontend routes only native listings
through it**; OpenSea buys keep going direct.

## Attacker pass (Murphy's-law, must hold under audit)
1. **Overpay → mis-attributed fee.** If `msg.value > price`, Seaport refunds the
   excess to the router, which would be counted as "fee" and credited to a referrer
   (buyer silently loses it). → **GUARD 1**: `msg.value` must equal the order's exact
   summed NATIVE consideration (`_nativeTotal`); otherwise revert `ValueMismatch`.
2. **NFT redirect / theft.** `recipient` is hard-set to `msg.sender` (the buyer); the
   router never custodies the NFT and the caller can't redirect it elsewhere.
3. **Drain the router.** It holds 0 ETH between calls (forwards `msg.value`, forwards
   the fee). `recordFee(msg.sender)` credits the **buyer's own** registered referrer,
   not an attacker-chosen address. No function moves ETH anywhere but Seaport (during
   the buy) or `treasury` (sweep). `nonReentrant` on `buy` + `sweepToTreasury`.
4. **Reentrancy.** External calls are only to trusted Seaport + our own splitter; the
   NFT is delivered straight to the buyer (no `onERC721Received` callback into the
   router). Guarded regardless.
5. **Stray-ETH attribution.** `priorBalance = balance − msg.value` excludes the
   payment, so only Seaport's payback delta is attributed; ETH sent directly to the
   router is swept to treasury, never attributed.
6. **Splitter misconfig bricks buys.** If the router isn't yet an approved caller (or
   the splitter's `setupComplete` is false / it's paused), `recordFee` reverts. →
   `recordFee` is wrapped in `try/catch`: on failure the fee stays in the router (swept
   to treasury) and **the buy still succeeds**. A misconfig degrades to "no
   attribution", never "can't buy".
7. **Dutch/dynamic native listings — OPEN on-chain, and it does NOT fail safe.**
   *Corrected 2026-09-02 (audit TF-048): this item used to claim a `ValueMismatch`
   revert made the case safe. It does not.* `_nativeTotal` sums `startAmount`
   only, so on a DECAYING order the router sends the START price while Seaport
   requires the (lower) current price, and Seaport **refunds the difference to
   the caller** — which is this router. The excess is then swept as protocol fee
   rather than returned to the buyer. The buy succeeds; the buyer simply overpays,
   and the overpayment is mis-booked. Nothing on-chain blocks it, so
   "the frontend must only route static listings" is a convention, not a guard.

   **What actually stops it today** is the API: `validateOrderShape`
   (`frontend/api/orderbook.js`) refuses any order whose consideration
   `startAmount != endAmount` (audit TF-021), so a decaying order cannot be
   listed through our orderbook at all. That closes the realistic path and does
   not close the contract-level one — a caller reaching the router directly with
   a Dutch order sourced elsewhere still hits this. An on-chain fix is a
   `startAmount == endAmount` check inside the `_nativeTotal` loop; it is not
   applied here because the router is live and the API gate covers every path
   this app creates.
8. **Approved-caller hygiene.** The router becomes an approved `recordFee` caller via
   the splitter's 24h-timelocked `proposeApprovedCaller` → `executeApprovedCaller`.
   On any router upgrade, `revokeApprovedCaller(oldRouter)` immediately.

## Frontend changes required (separate PR, after the contract is live)
1. `lib/orderbook.js createNativeListing`: set the **platform-fee consideration
   `recipient` to the router address** (gated on the router being deployed; fall back
   to `PLATFORM_FEE_RECIPIENT` when zero). Existing listings keep paying the treasury
   directly — only new listings route through the router.
2. The buy path (`fulfillNativeOrder`): when the order's fee recipient **is** the
   router, call `router.buy{value: price}(order, orderHash)` instead of Seaport
   directly. Non-native / non-router orders unchanged.
3. Capture `?ref=<addr>` and prompt a one-time `ReferralSplitter.setReferrer(addr)`
   (a separate user tx) so the buyer has a referrer on file before they buy.
4. A referral dashboard (referral link, `getReferralInfo` count/earned/pending,
   `claimReferralRewards`) — the Pro Pass "earn on referrals" perk made real.

## Deploy + wire (operator)
1. CI compile + fork tests + external audit (see top).
2. Deploy with `(_seaport, _referralSplitter, _treasury, _weth)`; owner = protocol
   multisig.
3. On ReferralSplitter: `proposeApprovedCaller(router)` → wait 24h →
   `executeApprovedCaller(router)` (and ensure `completeSetup()` has run).
4. Set `TEGRIDY_NATIVE_BUY_ROUTER_ADDRESS` in `frontend/src/lib/constants.ts`; the
   frontend changes above auto-gate on it.
5. Note: value scales with **native-book volume** (thin today). This is the rail that
   makes the native-default migration + referral salesforce worth running; it is not
   a standalone income source until native volume grows.

## Honest scope
- Helps **native** buys only. It does **not** unlock fees on OpenSea-routed buys
  (OpenSea fulfillment isn't our order; the affiliate program is dead) — that flow
  stays unmonetizable beyond moving it onto the native book.
- It is the on-chain prerequisite for NFT-side referrals; the income is gated on
  native volume + the operator wiring above.
