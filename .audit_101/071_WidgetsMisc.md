# Agent 071 — Widgets & Misc UI Forensic Audit

**Scope**: GaugeVoting.tsx, ReferralWidget.tsx, PriceAlertWidget.tsx, TegridyScore.tsx, TegridyScoreMini.tsx, TransactionReceipt.tsx, SeasonalEvent.tsx + .test, Confetti.tsx, GlitchTransition.tsx, LiveActivity.tsx
**Mode**: AUDIT-ONLY. No code changes.

---

## Summary Counts

| Severity | Count |
|----------|-------|
| HIGH     | 1 |
| MEDIUM   | 5 |
| LOW      | 6 |
| INFO     | 4 |
| **Total**| **16** |

---

## HIGH

### H-1 [SeasonalEvent.tsx] Cross-tab dismissal flag is unkeyed by user/wallet — global mute leakage between accounts

**File**: `frontend/src/components/SeasonalEvent.tsx:33-34, 75-79`

`isDismissed()` keys storage on event id only (`tegridy-event-dismissed-${id}`). Any visitor — connected or not, on shared/family devices, or after a wallet switch — inherits a previous user's dismissal. Because seasonal events drive 2x point multipliers (`multiplier: 2`), a user who never sees the banner may not know they should be staking during the campaign window. **Worse**: the prior threat model treats it as a UI nudge, but the `1` literal value makes it trivial for any third-party script with same-origin storage access (browser extensions, embedded iframes if any, dev-mode panels) to globally suppress all promotional banners by writing the keys preemptively.

Recommend keying by wallet address (`tegridy-event-dismissed-${id}-${address}`) and clearing on disconnect, or migrating to a per-account React state.

---

## MEDIUM

### M-1 [GaugeVoting.tsx] Reveal salt persists in `localStorage` plaintext indefinitely after epoch ends

**File**: `frontend/src/components/GaugeVoting.tsx:40-43, 282-287`

`saveCommitment()` writes `{salt, gauges, weights, commitmentHash}` to `localStorage` and is only `clearCommitment()`-ed when `isSuccess && hasVotedThisEpoch && commitmentKey` after a confirmed reveal (line 284). If the user **never reveals** (commit window closes, illiquid, switches device) the salt stays in `localStorage` forever, keyed `tegridy:gaugeCommit:{chainId}:{voter}:{tokenId}:{epoch}`. This is not a privacy leak per se but:
- After the epoch passes, the salt is useless yet still consumes quota.
- Voting choices for past epochs become permanently inspectable via `localStorage` to anyone with same-origin script access (extensions, XSS).
- No GC pass cleans stale `tegridy:gaugeCommit:*` keys for older epochs.

Recommend adding a sweep on mount: enumerate `tegridy:gaugeCommit:*` keys whose `epoch` is more than 2 epochs old and `removeItem`. Also consider clearing the key when `hasVotedThisEpoch` becomes true regardless of the just-confirmed tx.

### M-2 [ReferralWidget.tsx] URL `?ref=` parameter trusted via `isAddress()` only — no on-chain or anti-sybil checks

**File**: `frontend/src/components/ReferralWidget.tsx:50-62`

Mount effect reads `?ref=<addr>` from `window.location.search`, validates only that it's a valid 20-byte address and not the user's own. The address is then prefilled into `refInput` and shown as "You arrived with a referral link" (line 180-182). There is **no** check that:
- The referrer has actually staked / interacted (i.e., is a real user, not a sybil farm).
- The referrer is not a contract (could be a malicious contract designed to siphon the splitter on transfer).
- The URL hasn't been DOM-clobbered by a meta-refresh chained from a malicious site.

The on-chain `setReferrer` may have its own validation, but this widget cheerfully prefills any 0x… string and presents it as legitimate UX. Combined with no rate-limit on the URL parameter, this is a vector for sybil farms: a fraudster can drop `?ref=<their addr>` on every page-share, then collect referral fees from organic-looking users who land on the site via random share links.

Recommend (a) cross-checking via a quick public RPC `eth_getCode` to ensure EOA, (b) showing the URL-derived ref behind a "Use this referrer?" confirm button rather than auto-prefilling, (c) per-IP/per-session URL ref rate limit, and (d) on-chain self-referral guard (already addressed by `referrer.toLowerCase() !== address.toLowerCase()` but only client-side).

### M-3 [PriceAlertWidget.tsx + usePriceAlerts.ts] No notification permission gate — alerts are added before browser permission is established

**File**: `frontend/src/components/PriceAlertWidget.tsx:16-21`, `frontend/src/hooks/usePriceAlerts.ts:48-57, 67-89`

Users can add unlimited (capped at 20) price-alert entries and trigger logic runs on price change without first establishing `Notification.permission === 'granted'`. The permission request happens **at trigger time** inside `sendNotification()` (usePriceAlerts.ts:53). If the permission prompt is denied at that moment, the alert silently triggers (sets `triggered: true`) with no user-visible notification — the user thinks alerts work, then never gets one. There is also no fallback (no toast, no in-app banner) when the browser blocks notifications, so the feature appears broken.

Recommend: (a) prompt for `Notification.requestPermission()` on first "Add" click, (b) show a clear "Notifications blocked" UI banner if `Notification.permission === 'denied'`, (c) emit a `toast.success(...)` as fallback notification when the system Notification API fails or is denied, (d) persist a `notificationPermissionState` and surface it in the widget so the user can see why alerts aren't firing.

### M-4 [TegridyScore.tsx + useTegridyScore.ts] Score computed from `usePoints` client-state — `data?.onChainPoints` may be reconciled from localStorage

**File**: `frontend/src/components/TegridyScore.tsx:21`, `frontend/src/hooks/useTegridyScore.ts:177, 343`, `frontend/src/hooks/usePoints.ts:99-100`

`useTegridyScore` consumes `points.data?.onChainPoints` directly into `calcActivityScore()` (line 343). `usePoints` calls `reconcilePoints(address, onChainPts)` (usePoints.ts:100) which mixes localStorage-stored historical client points with the on-chain-computed value. If a user manipulates `localStorage` keys for the points engine, their `activityScore` (15% of total Tegridy Score) inflates without on-chain backing. The score is presented to the user as "On-chain verified" (TegridyScoreMini.tsx:85) and "Score based on on-chain activity" (TegridyScore.tsx:113), which is **misleading** when activity score has client-side amplification.

Recommend: either (a) make `activityScore` use `computeOnChainPoints(metrics)` directly without the `reconcilePoints` step, or (b) remove the "on-chain verified" UI claim, or (c) split the displayed score into "verified" vs "self-reported" buckets (the hook already has `selfReported: []` infrastructure but it's empty).

### M-5 [SeasonalEvent.tsx] `getActiveEvent()` uses `Date.now()` against UTC ISO strings without explicit timezone handling — `endDate` boundary edge case

**File**: `frontend/src/components/SeasonalEvent.tsx:8-9, 27-30, 89`

Dates are stored as ISO 8601 with explicit `Z` (UTC), and `new Date(...).getTime()` correctly returns UTC milliseconds. Test boundary at `2026-06-01T00:00:00Z` passes because `now >= start` is inclusive (line 29). However:
- `endDate: '2026-06-05T00:00:00Z'` means the banner disappears at exactly midnight UTC June 5. For a US-Pacific user, this is **5 PM June 4 local** — the banner vanishes mid-afternoon on what they perceive as "the last day of the campaign." Test at `2026-06-06T00:00:00Z` confirms this exact behavior (line 47-51) but doesn't catch the UX confusion.
- `formatCountdown()` shows days/hours/minutes but never the timezone, so users in non-UTC zones see "0d 5h 23m" without context.
- `Harvest Season` window is **only 4 days** (June 1-5 exclusive), which seems short for a "season" — possibly an off-by-one in the constant (intent may have been June 1-5 **inclusive** = 5 days, requiring `endDate: '2026-06-06T00:00:00Z'`).

Recommend: either (a) use `endDate: '2026-06-05T23:59:59Z'` for inclusive end-day semantics, or (b) display the explicit end date with timezone in the UI, e.g., "Ends June 5 00:00 UTC".

---

## LOW

### L-1 [GaugeVoting.tsx] `useCountdown` interval persists when component unmounts mid-render
**File**: `frontend/src/components/GaugeVoting.tsx:88-100`
The cleanup correctly clears the interval, but `useCountdown(revealOpensAt)` is invoked inside conditional JSX (line 392). Conditionally calling a hook violates Rules of Hooks. If `revealOpen` flips between renders, React will crash with "Rendered more hooks than during the previous render." This is a latent bug, not just a leak.

### L-2 [TransactionReceipt.tsx] No zod validation on `receipt.data` — relies on TypeScript at compile time only
**File**: `frontend/src/components/TransactionReceipt.tsx:88-167, 5-9`
`buildDetailRows()` blindly destructures `data.fromAmount`, `data.fromToken`, etc. The hook `useTransactionReceipt.ts:5-48` defines the shape but has no runtime validator. Since `showReceipt(data)` is callable from anywhere — including imported user-controlled blockchain data — a malformed `ReceiptData` (e.g., `data.amount` is `null` or an object) would crash the renderer or display garbage. The `sanitize()` function only protects against XSS, not against type confusion. Notably `formatTokenAmount(data.fromAmount, 6)` on a non-string would throw.

Recommend a small zod schema in `useTransactionReceipt.ts` and validate inside `showReceipt`.

### L-3 [TransactionReceipt.tsx] `blockTimestamp` parsed as `Number()` without bounds check
**File**: `frontend/src/components/TransactionReceipt.tsx:185-198`
`new Date(Number(receipt.data.blockTimestamp) * 1000)` will silently produce `Invalid Date` if `blockTimestamp` is `"abc"` or beyond `Number.MAX_SAFE_INTEGER`, then `.toLocaleString()` returns `"Invalid Date"` — visible to the user.

### L-4 [Confetti.tsx + useConfetti.ts] `setTimeout(..., 4000)` not cancellable; canvas not resized on viewport change
**File**: `frontend/src/hooks/useConfetti.ts:131-135`, `frontend/src/components/Confetti.tsx:5-15`
Each `fireConfetti()` call creates a new 4-second `setTimeout` to clean up. If the Confetti provider unmounts mid-burst, the timeout still fires and accesses `ctx.clearRect` — likely safe (canvas survives ref change) but creates a memory pin on the canvas element preventing GC for 4 seconds after unmount. Also, `canvas.width = window.innerWidth` is set inside `fireConfetti` only; if the user resizes the window mid-burst, particles are clipped.

### L-5 [GlitchTransition.tsx] `setTimeout` array in DesktopGlitchTransition cleanup uses mutable `[tSub, tSubOff, ...]` — relies on closure capture being correct
**File**: `frontend/src/components/GlitchTransition.tsx:646-662`
The cleanup `[tSub, tSubOff, tFlash, tFlashOff, tFlash2, tFlash2Off, tAfter, tDone].forEach(clearTimeout)` (line 661) is correct, but if any single `setTimeout` ever runs early due to a duration mutation between renders, the timer ids returned could change before cleanup. The `useEffect` deps include `config.duration, subliminal.showAt, subliminal.showDur` — any of these changing while the effect is mid-flight will leak the prior timers (cleanup runs but new effect starts). Low impact (duration is constant per call site), but worth noting for any future config-via-props use.

Also note that the `loop` inside `MobileGlitchTransition` uses `cancelAnimationFrame(rafRef.current)` only on the **last** scheduled rAF id, not any prior. Since each iteration overwrites `rafRef.current = requestAnimationFrame(loop)`, this is correct — but if `setDone(true)` is called inside the loop (line 122) the early return fires `return` before reassigning `rafRef.current`, so the next frame's old rAF is never explicitly cancelled. React's effect cleanup will fire `cancelAnimationFrame(rafRef.current)` against the most recent id, but if `loop` returned early it points to the *previous* frame which has already executed → harmless no-op. Behavior is correct; comment-worthiness only.

### L-6 [LiveActivity.tsx] No WebSocket — false alarm for the leak hypothesis
**File**: `frontend/src/components/LiveActivity.tsx:1-60`
LiveActivity uses `useTOWELIPrice()` and `usePriceHistory()`. Inspection of `usePriceHistory.ts:1-50` shows it's a polling fetch with `AbortController`, not a websocket. Confirmed **no websocket leak**. The single `setTimeout` for `setVisible(true)` is correctly cleaned (line 14-17). LiveActivity itself is leak-free; the price-context dependencies are out of scope but worth a separate audit.

---

## INFO

### I-1 [GaugeVoting.tsx] Salt is generated via `crypto.getRandomValues` — strong, no concern
**File**: `frontend/src/components/GaugeVoting.tsx:79-83`
Confirmed CSPRNG. No weakness.

### I-2 [GaugeVoting.tsx] Commitment hash includes `chainid + gcAddress + voter + tokenId + gauges + weights + salt + epoch` — defends cross-fork replay
**File**: `frontend/src/components/GaugeVoting.tsx:52-77`
Solid pattern. Audit comment "AUDIT NEW-I2" already documents the rationale. Salt-loss hypothesis is correctly mitigated by `saveCommitment` running **before** `writeContract` (line 247-250). The "user closed tab between commit and reveal" failure mode is caught by L-2 banner ("On-chain commitment found but no local salt to reveal it"). Defense-in-depth is good here.

### I-3 [TransactionReceipt.tsx] `sanitize()` and `sanitizeTxHash()` correctly defend XSS in user-controlled fields
**File**: `frontend/src/components/TransactionReceipt.tsx:14-31`
Tx hash regex `/^0x[a-fA-F0-9]{64}$/` is correct. HTML escaping is correct. The risk surface from L-2 is type confusion, not XSS.

### I-4 [SeasonalEvent.test.tsx] Test coverage is solid — boundary tests at start, mid, end, after-end, and pre-start
**File**: `frontend/src/components/SeasonalEvent.test.tsx:27-93`
Good UTC boundary tests. Missing: timezone-shift test (e.g., system in PST while events are UTC), and test for the second event ("Ape Month") full lifecycle (only the start is tested). M-5 timezone fragility is not exercised by any test.

---

## Files Inspected

- `frontend/src/components/GaugeVoting.tsx` (532 lines)
- `frontend/src/components/ReferralWidget.tsx` (240 lines)
- `frontend/src/components/PriceAlertWidget.tsx` (115 lines)
- `frontend/src/components/TegridyScore.tsx` (160 lines)
- `frontend/src/components/TegridyScoreMini.tsx` (89 lines)
- `frontend/src/components/TransactionReceipt.tsx` (433 lines)
- `frontend/src/components/SeasonalEvent.tsx` (117 lines)
- `frontend/src/components/SeasonalEvent.test.tsx` (94 lines)
- `frontend/src/components/Confetti.tsx` (33 lines)
- `frontend/src/components/GlitchTransition.tsx` (737 lines)
- `frontend/src/components/LiveActivity.tsx` (59 lines)
- `frontend/src/hooks/useTegridyScore.ts` (cross-ref for M-4)
- `frontend/src/hooks/usePriceAlerts.ts` (cross-ref for M-3)
- `frontend/src/hooks/useTransactionReceipt.ts` (cross-ref for L-2)
- `frontend/src/hooks/useConfetti.ts` (cross-ref for L-4)
- `frontend/src/hooks/usePriceHistory.ts` (cross-ref for L-6)
- `frontend/src/hooks/usePoints.ts` (cross-ref for M-4)

— Agent 071, AUDIT-ONLY
