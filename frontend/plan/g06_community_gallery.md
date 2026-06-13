# Remediation Plan — g06_community_gallery (Community + Gallery)

Surface: `/community` (Governance / Bounties / Vote Incentives / Gauge Voting) and `/gallery` (+ lightbox).
Worked at HEAD of `mvp-launch`. Every finding below was confirmed against the cited source before planning. Findings already correct at HEAD (prod is stale) are marked `redeploy-only`; vague/incorrect ones are marked `false-positive`.

Key cross-cutting confirmations:
- The lightbox content wrapper's `animate` prop omits `opacity: 1` (ArtLightbox.tsx:90) — that is the frozen-tween bug (F354, T2).
- Nav reachability and the gallery vote affordance both **exist at HEAD** (`navConfig.ts` `PROMOTE_PENDING=true`; `GalleryPage.tsx:138-150`) — the live agent saw an older prod build (T1).
- The whole-page connect-wall (F322/F356/F357) is one real fix: render read-only data, gate only the write buttons.

---

## Batch: gallery-lightbox-settle  (F354)

The single most severe item on this surface — the gallery's core interaction is dead. Fix is one prop.

### F354 — Lightbox opens permanently invisible (frozen at opacity 0)
- verdict: fix-now
- rootCause: T2
- confirm: `ArtLightbox.tsx:89-91` — content wrapper is `initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1 }} exit={{ scale: 0.95, opacity: 0 }}`. The `animate` object sets `scale` but **not** `opacity`, so under LazyMotion `domAnimation` the spring drives scale toward 1 while opacity stays pinned at its initial `0`. Backdrop (`opacity:0→1`, line 86) settles fine; only the inner wrapper never reappears. Matches the live repro exactly (`opacity:0; transform:scale(0.975…)` stuck mid-flight).
- approach: Add `opacity: 1` to the wrapper's `animate` object: `animate={{ scale: 1, opacity: 1 }}`. No new code, no art touched. Optionally also give the spring `transition` an explicit `stiffness/damping` but the missing opacity key is the whole bug.
- files: `src/components/ui/ArtLightbox.tsx:90`
- effort: S
- risk: low
- test: Manual — open `/gallery`, click any card, confirm image + Prev/Close/Next fade in and stay visible; Escape/backdrop still close. Add a render test asserting the wrapper's resolved `animate` contains `opacity:1`.
- deps: []

---

## Batch: community-read-only-wall  (F322, F356, F357)

One structural change: stop hiding public contract reads behind `isConnected`. Render each section always; gate only vote/deposit/create/claim buttons (those already individually guard on `address`/chain). Add per-tab intro copy while restructuring the gate.

### F322 — Entire Community page is connect-walled
- verdict: fix-now
- rootCause: T7
- confirm: `CommunityPage.tsx:111-133` renders the four sections only in the `isConnected` branch; the `!isConnected` branch shows a single generic Connect card. Sections already tolerate `address === undefined` (e.g. `GrantsSection.tsx:67` returns `[]` for vote-checks; bounty/bribe reads gate their *user* reads on `!!address` but list reads do not).
- approach: Remove the `!isConnected ?` gate around the tab panel; always render the active section inside the existing `ErrorBoundary`/`Suspense`. Each section's write buttons already no-op or are guarded — additionally render an inline "Connect to vote/deposit" CTA where a button would be (reuse `ConnectButton` from RainbowKit, same import already present). GaugeVoting's own `!isConnected` early-return (`GaugeVoting.tsx:309-318`) should likewise switch to showing read-only gauge weights with a connect CTA on the vote form only.
- files: `src/pages/CommunityPage.tsx:111-164`, `src/components/GaugeVoting.tsx:309-318`
- effort: M
- risk: med (touches the page's top-level branch + GaugeVoting early-return; verify hooks still run unconditionally)
- test: Manual logged-out — each tab shows proposals/bounties/gauge weights/bribe leaderboard read-only; vote/deposit replaced by Connect CTA. Logged-in unchanged.
- deps: []

### F356 — All four tabs are a hard connect-wall logged-out (live)
- verdict: duplicate
- rootCause: T7
- confirm: Same DOM cause as F322 (`CommunityPage.tsx:111`). Live observation of the identical "Connect your wallet to participate" card.
- approach: Fixed by F322. No separate work.
- files: `src/pages/CommunityPage.tsx:111-133`
- effort: S
- risk: low
- test: Covered by F322.
- deps: [F322]

### F357 — Identical gate message on every tab; no per-tab explanation
- verdict: fix-now
- rootCause: T7
- confirm: `CommunityPage.tsx:129` shows one static "Connect your wallet to participate" for all sections; tabs only change `?section=`. Bribes already has rich in-section copy (`HowItWorks`, `PersonaCards`) but it's hidden behind the wall.
- approach: When F322 renders sections read-only, the per-section explainer copy becomes visible (Bribes `HowItWorks`, Bounties/Grants form copy). For Governance/Bounties (which lack a one-liner), add a single sentence header per tab describing what it is + what connecting unlocks. Centralize the four strings in `src/lib/copy.ts` (a `COMMUNITY_TAB_INTRO` map) next to `GOVERNANCE_COPY`.
- files: `src/pages/CommunityPage.tsx` (header area near :67-71), `src/lib/copy.ts:86-94`
- effort: S
- risk: low
- test: Manual — switch tabs logged-out; each shows a distinct one-sentence description.
- deps: [F322]

---

## Batch: community-time-left-format  (F318)

### F318 — Active deadlines render "Ends just now" / "just now"
- verdict: fix-now
- rootCause: standalone (shared formatter bug, but a new helper not one of T1-T12)
- confirm: `formatting.ts:42-44` — `seconds = floor(now - timestamp)`; a future deadline → negative seconds → `< 5` → `'just now'`. `GrantsSection.tsx:286` and `BountiesSection.tsx:260` both do `formatTimeAgo(deadlineNum).replace(' ago',' left')`, and `'just now'` has no `' ago'` so the replace is a no-op. Confirmed broken.
- approach: Add `export function formatTimeLeft(timestamp)` to `formatting.ts` (mirror the existing `formatCountdown` in `VoteIncentivesSection.tsx:54` — d/h/m). Replace both call sites: `Ends ${formatTimeLeft(deadlineNum)}` and `${formatTimeLeft(deadlineNum)} left`. Keep `isPastDeadline` branch as-is.
- files: `src/lib/formatting.ts` (new export after :49), `src/components/community/GrantsSection.tsx:286`, `src/components/community/BountiesSection.tsx:260`
- effort: S
- risk: low
- test: Unit test `formatTimeLeft(now+6*86400)` → `'6d …'`; `formatTimeLeft(now-10)` → `'0m'`/`'Ended'`-safe. Manual: an active proposal shows "6d 3h left".
- deps: []

---

## Batch: community-write-feedback-refetch  (F320, F321, F328, F340)

Shared cause: write hooks don't read `error`/`isSuccess`, fire premature toasts, and reads never refetch on receipt. `useBribes.ts:337-349` is the in-house pattern to copy (success toast + `refetchAll()` + `reset()`), but it also has its own rough edge (rejection → "Transaction failed"), handled in F340.

### F320 — GaugeVoting tx errors never surfaced; try/catch is dead code
- verdict: fix-now
- rootCause: T5
- confirm: `GaugeVoting.tsx:109` destructures `{ writeContract, data: txHash, isPending }` — no `error`. The `try/catch → surfaceTxError` at :217-225/:252-260/:269-277 can't catch wagmi v2's non-async `writeContract` (failures go to hook `error` state). A rejection/revert produces no toast.
- approach: Add `error: writeError` to the `useWriteContract()` destructure and `isError: isTxError` to `useWaitForTransactionReceipt`. In the existing `isSuccess` effect (:281-291) add `if (isTxError || writeError) surfaceTxError(writeError ?? …, toast, {component:'GaugeVoting'})`. Remove the dead try/catch wrappers (they mislead future readers) — leave the handler bodies. Mirrors `useBribes.ts:344-348`.
- files: `src/components/GaugeVoting.tsx:109-110, 217-291`
- effort: S
- risk: low
- test: Manual — reject a Commit in wallet → error toast, button resets. Force a revert (insufficient power) → toast.
- deps: []

### F321 — Grants/Bounties: no success/error feedback, no refetch, dangling "Voting FOR…" toast
- verdict: fix-now
- rootCause: T5
- confirm: `GrantsSection.tsx:40-41` / `BountiesSection.tsx:43-44` use `useWriteContract`/`useWaitForTransactionReceipt` but never read `error`/`isSuccess`. `handleVote` fires `toast.info('Voting FOR…')` (`GrantsSection.tsx:83`) before the wallet prompt; nothing on confirm/reject. No read sets `refetchInterval` or refetches on receipt, so `hasVotedOnProposal`/vote bars stay stale until window refocus.
- approach: In both sections add `error: writeError` + `isSuccess` (from the receipt hook) and an effect: on `isSuccess` → `toast.success` + refetch the relevant reads. Use wagmi's `refetch` from each `useReadContract`/`useReadContracts` (destructure `refetch` and call them in the effect), or invalidate via `useQueryClient`. On `isError || writeError` → `surfaceTxError`. Move the optimistic `toast.info` to after `writeContract` returns a hash (see F340). Pattern source: `useBribes.ts:337-349`.
- files: `src/components/community/GrantsSection.tsx:40-93,115-145`, `src/components/community/BountiesSection.tsx:43-117`
- effort: M
- risk: med (multiple reads to wire to refetch; verify no refetch loops)
- test: Manual — vote on a proposal → success toast + "You have already voted" appears without refocus; reject → cancelled toast, no stuck "Voting FOR…".
- deps: []

### F328 — Duplicate "Transaction confirmed" toast from the isSuccess effect re-running
- verdict: fix-now
- rootCause: T5
- confirm: `GaugeVoting.tsx:281-291` effect deps include `hasVotedThisEpoch`; `useWriteContract` is never `reset()`, so `isSuccess` stays true, and when `lastVotedEpoch` later flips `hasVotedThisEpoch`, the effect re-runs → second `toast.success`. Local record cleanup is also deferred (no explicit `refetch` of `lastVotedEpoch`).
- approach: Call `reset()` after handling (add `reset` to the destructure, as `useBribes.ts:341` does) so `isSuccess` returns to false, and/or guard with a `toastedHashRef`. Add `refetch` of `lastVotedEpoch` (destructure its `refetch`) inside the effect so cleanup isn't deferred. Lands in the same edit as F320.
- files: `src/components/GaugeVoting.tsx:109,156-159,281-291`
- effort: S
- risk: low
- test: Manual — reveal a vote, confirm exactly one success toast; the committed-ballot card clears promptly.
- deps: [F320]

### F340 — Art-index reuse and premature toasts (cancel reads as failure)
- verdict: fix-now
- rootCause: T4 (fake/misleading feedback) + standalone (art idx)
- confirm: (a) `CommunityPage.tsx:153` and `:159` both pass `idx={1}` to `FeatureNotDeployed` (Governance + Vote-Incentives placeholders share a backdrop; bounties uses idx 2). (b) Premature `toast.info('Voting FOR…'/'Creating…')` at `GrantsSection.tsx:83/144` and `BountiesSection.tsx:88/104`. (c) `useBribes.ts:344-345` toasts `'Transaction failed'` for `writeError` including user rejection.
- approach: (a) Give the bribes placeholder a distinct idx (e.g. `idx={3}`) — additive, no art removed. (b) Covered by F321: move toasts to post-`writeContract` (hash available). (c) In `useBribes.ts` effect, special-case rejection: `if (writeError?.name === 'UserRejectedRequestError') toast('Transaction cancelled')` else `toast.error('Transaction failed')` — reuse `surfaceTxError` from `src/lib/txErrors.ts` which already classifies this.
- files: `src/pages/CommunityPage.tsx:159`, `src/hooks/useBribes.ts:344-348`
- effort: S
- risk: low
- test: Reject a bribe deposit → neutral "cancelled" toast, not "failed". Compare Governance vs Vote-Incentives placeholder backdrops differ.
- deps: [F321]

---

## Batch: bribes-claimables-decimals  (F319)

### F319 — Claimables panel formats every token with formatEther + shows raw addresses
- verdict: fix-now
- rootCause: T6
- confirm: `VoteIncentivesSection.tsx:474-478` renders `formatTokenAmount(formatEther(c.amounts[i]…),4) … shortenAddress(tok)`. `GaugeRow` does it right via `whitelistMap` (`formatUnits(b.amount, meta.decimals)` + `meta.symbol`, :613-618), but `whitelistMap` (built at :1234-1238) is **not** passed to `ClaimablesPanel` (props at :1386-1393; component signature :408-415 has no `whitelistMap`). A 6-decimal token displays 1e12× too small.
- approach: Add `whitelistMap` to `ClaimablesPanel`'s props and pass it from the section. In the token map (:474-479) look up `meta = whitelistMap.get(tok.toLowerCase())` and render `formatUnits(amount, meta.decimals)` + `meta.symbol`, falling back to `formatEther`/`shortenAddress` only when `meta` is undefined and `tok !== ZERO_ADDRESS` (ETH stays special-cased). Mirrors `GaugeRow` exactly.
- files: `src/components/community/VoteIncentivesSection.tsx:408-415,474-479,1386-1393`
- effort: S
- risk: low
- test: With a whitelisted 6-decimal token claimable, the amount and symbol match GaugeRow's badge. ETH still shows "ETH".
- deps: []

---

## Batch: gauge-pair-labels  (F327)

### F327 — Gauge rows show only truncated addresses; useGaugeList labels unused
- verdict: fix-now
- rootCause: T6
- confirm: `GaugeVoting.tsx:368` and the ballot summary :483/:515 use `shortenAddress(gauge,…)`. The sibling bribes tab resolves human labels ("TOWELI / WETH") via `useGaugeList` (`useGaugeList.ts:157-159`). Same gauge reads as a name on one tab, `0x…` on the next.
- approach: Import `useGaugeList` in GaugeVoting; build a `Map<pairLower, label>` and render `labelMap.get(gauge.toLowerCase()) ?? shortenAddress(gauge,6)` at the three display sites. `useGaugeList` already memoizes + event-refreshes, so no extra polling cost beyond the shared hook. Keep the address as a mono sub-label (additive).
- files: `src/components/GaugeVoting.tsx:8,368,483,515`
- effort: S
- risk: low
- test: Manual — gauge rows show "TOWELI / WETH" matching the bribes tab; unknown pairs still show the short address.
- deps: []

---

## Batch: legacy-route-section-param  (F317)

### F317 — /bounties and /bribes redirect to bare /community (wrong tab)
- verdict: fix-now
- rootCause: standalone
- confirm: `App.tsx:150` `path="bounties" → <Navigate to="/community" replace/>` and `:153` `path="bribes" → /community`; `:159` `governance → /community`; `:149` `grants → /community`. `CommunityPage.tsx:43` defaults to `'grants'` when `?section=` absent, so all four legacy deep-links open Governance. The page comment (:29-30) promises they "land on the right tab".
- approach: Change the three non-default redirects to carry `?section=`: `bounties → /community?section=bounties`, `bribes → /community?section=bribes`, `governance` stays `/community` (grants is the default) or `?section=grants` for clarity. `grants → /community` is already correct (default). `CommunityPage.sectionFromQuery` already accepts these values.
- files: `src/App.tsx:150,153`
- effort: S
- risk: low
- test: Visit `/bounties` → lands on Bounties tab; `/bribes` → Vote Incentives tab.
- deps: []

---

## Batch: incentives-url-param-naming  (F368)

### F368 — "Vote Incentives" tab emits ?section=bribes (leaks internal naming)
- verdict: product-decision
- rootCause: T3 (constant drift between UI label and URL)
- confirm: `CommunityPage.tsx:23` maps the `bribes` key to label "Vote Incentives"; `VALID_SECTIONS` (`:27`) uses `'bribes'`. Deep links work but the shareable URL says `bribes`, the word the UI deliberately avoids (copy calls it "Cartman's Market"/"Vote Incentives").
- approach: Decide whether to rename the param. If yes: accept both in `sectionFromQuery` (map `'incentives' → 'bribes'`) but emit `?section=incentives` in `handleSectionChange` — and update F317's redirect target. Backward-compatible. This is cosmetic; flag for owner because it changes shareable URLs and the legacy-redirect target (`bribes`) interacts with F317.
- files: `src/pages/CommunityPage.tsx:18-50`, `src/App.tsx:153`
- effort: S
- risk: low
- test: `?section=incentives` and `?section=bribes` both open Vote Incentives; clicking the tab produces `?section=incentives`.
- deps: [F317]

---

## Batch: community-loading-skeletons  (F326)

### F326 — Loading conflated with empty: "No proposals/bounties yet" flashes during reads
- verdict: fix-now
- rootCause: T11
- confirm: `GrantsSection.tsx:50` `count = proposalCount!==undefined ? Number : 0` then `:250` renders "No proposals yet" when `count===0` — true while `proposalCount` is still `undefined` (loading). Same in `BountiesSection.tsx:58,223`. When `count>0` but `proposalResults` is undefined the list body is blank with no skeleton. The page-level `Suspense` fallback never fires (sections are statically imported; wagmi hooks don't suspend).
- approach: Track loading explicitly: branch on `proposalCount === undefined` (and `proposalResults === undefined` while `count>0`) to render a row skeleton, only showing the empty copy when `proposalCount !== undefined && count === 0`. Copy the in-house shape-matching skeleton from the bribes leaderboard (`VoteIncentivesSection.tsx:1431-1451`). `useReadContract` exposes `isLoading` — destructure it for the precise signal.
- files: `src/components/community/GrantsSection.tsx:43-52,250`, `src/components/community/BountiesSection.tsx:46-58,223`
- effort: S
- risk: low
- test: Throttle network — list shows skeleton rows then content; "No proposals yet" only when genuinely empty.
- deps: []

---

## Batch: bounties-input-validation  (F330)

### F330 — handleCreate runs parseEther/Number on unvalidated input; 0/negative deadline reaches chain
- verdict: fix-now
- rootCause: standalone
- confirm: `BountiesSection.tsx:86` `value: parseEther(newReward)` has no try/catch (viem throws on `'1e5'`-style exponent notation, which `type=number` inputs allow). `:81` `Number(newDeadlineDays)*86400` accepts `'0'`/negative (the `!newDeadlineDays` guard at :73 passes for `'0'` since it's a truthy string), producing an in-past deadline that reverts after gas. No belowMin/insufficient-balance checks. `GrantsSection.tsx:121-131` already does this correctly.
- approach: Mirror GrantsSection: wrap `parseEther(newReward)` in try/catch with `toast.error`; require `Number(newDeadlineDays) >= 1`; add a `canCreate` derived flag and disable the submit button on invalid values (the button at :205 only checks `!newDescription || !newReward`). Optionally check balance like DepositCard's `insufficientBalance`.
- files: `src/components/community/BountiesSection.tsx:71-89,205-209`
- effort: S
- risk: low
- test: Enter `1e5` reward → toast, no throw; deadline `0` → button disabled. Valid input still posts.
- deps: []

---

## Batch: bounties-nested-button  (F329)

### F329 — Nested <button> inside <button> (SafeText "show more" inside the row-expand button)
- verdict: fix-now
- rootCause: T10
- confirm: `BountiesSection.tsx:241` row header is `<button onClick={…expand}>` wrapping `:250` `<SafeText value={description} previewChars={180} />`; `SafeText.tsx:42-53` renders its own `<button>` when text > previewChars (descriptions can be 1000, `DEFAULT_DESCRIPTION_LIMIT`). Invalid HTML + a11y hazard. GrantsSection avoids this (SafeText sits in a `<p>`, `GrantsSection.tsx:274-276`).
- approach: Make the bounty row header a `div role="button" tabIndex={0}` with `onKeyDown` Enter/Space (same pattern as the gallery card at `GalleryPage.tsx:104-106`) instead of a `<button>`, so the inner SafeText button is no longer nested. Alternatively move SafeText out of the toggle into a sibling `<p>` below the header. Prefer the role=button conversion to keep the whole row clickable.
- files: `src/components/community/BountiesSection.tsx:241-262`
- effort: S
- risk: low
- test: DOM has no button-in-button; keyboard Enter/Space toggles the row; screen reader announces one control.
- deps: []

---

## Batch: bribes-commit-index-reconcile  (F315)

### F315 — Commit-reveal commitIndex is guessed before tx confirmation (bond-loss risk)
- verdict: fix-now
- rootCause: T5
- confirm: `VoteIncentivesSection.tsx:1290-1302` — `handleCommitVote` calls `bribes.commitVote(...)` then immediately persists with `tentativeIndex = existing.length` and the comment (:1295) "we'll reconcile by reading voterCommits.length on next refetch" — but `voterCommits` (ABI at `contracts.ts:286`) is **never read** in the frontend (grep: only the ABI entry + this comment). A rejected/failed commit leaves a phantom localStorage record; every subsequent commit gets an off-by-N index; `revealVote` with a wrong index reverts and the 10 TOWELI bond is forfeit (copy at :901). Reveal never removes the record on success (double-reveal possible). The sibling `GaugeVoting` does this more safely (stages salt, persists keyed record).
- approach: (1) Only persist the commit record **after** receipt success — stage the salt/pair/power in component state pre-broadcast (like `GaugeVoting.handleCommit` keeps the record but keys it deterministically). (2) On confirmation, read the real index: add a `voterCommits` length read (or read the emitted index from the commit event via `useWatchContractEvent` on the bribes `Committed`/`GaugeCommitted` event) and assign `commitIndex` then. (3) On successful reveal, remove the record (mirror `GaugeVoting.tsx:287-289` `clearCommitment`). (4) Add a "dismiss stale commit" button on each stored-commit row (:958-968) so a phantom record can be cleared. Keep changes additive to the existing CommitRecord store.
- files: `src/components/community/VoteIncentivesSection.tsx:1290-1305,951-972`, possibly `src/hooks/useBribes.ts` (expose a `voterCommitsLength` read / commit-event watcher)
- effort: M
- risk: med (touches the commit-reveal money path; verify the on-chain index semantics match `voterCommits[user][epoch].length` before assigning)
- test: Reject a commit → no phantom record persisted. Successful commit → stored index equals on-chain `voterCommits` length-1. Reveal → record removed, can't double-reveal. Unit-test the index-assignment helper.
- deps: []

---

## Batch: bribes-orphan-refund-button  (F338)

### F338 — RescueBanner tells depositors to call refundOrphanedBribe but provides no button
- verdict: fix-now
- rootCause: standalone (missing affordance; ABI gap)
- confirm: `VoteIncentivesSection.tsx:217-221` banner copy instructs `refundOrphanedBribe(epoch,pair,token)` and `advanceEpoch` "below". `advanceEpoch` has a footer chip (:1533) but **no UI calls `refundOrphanedBribe`** — and it is **not even in `VOTE_INCENTIVES_ABI`** (grep: only the two copy mentions in this file; absent from `contracts.ts`). So the function isn't callable from the app at all.
- approach: (1) Add the `refundOrphanedBribe(uint256 epoch, address pair, address token)` entry to `VOTE_INCENTIVES_ABI` in `contracts.ts` (verify the exact signature against the deployed contract first). (2) Add a `refundOrphanedBribe` action to `useBribes.ts` (same chainId-pinned pattern as the other writes). (3) When the rescue window is open, render per-(pair,token) Refund buttons inside `RescueBanner` for the connected depositor's net contributions. Gate the button on connection (consistent with F322).
- files: `src/lib/contracts.ts` (ABI), `src/hooks/useBribes.ts:156-289`, `src/components/community/VoteIncentivesSection.tsx:205-225`
- effort: M
- risk: med (must match the on-chain signature exactly; refund is a money path)
- test: Simulate an orphaned epoch on a fork; the Refund button calls `refundOrphanedBribe` with the right args and returns the depositor's net contribution.
- deps: []

---

## Batch: gauge-salt-export  (F325)

### F325 — Banner says "export the salt" but no export affordance exists
- verdict: fix-now
- rootCause: standalone
- confirm: `GaugeVoting.tsx:410` — "Keep this browser's localStorage intact, or export the salt before then." No copy/download/QR button; `loadCommitment`/`saveCommitment` (:31-47) are localStorage-only. Losing the salt is fatal (:413). Same gap on the bribes `CommitRecord` store.
- approach: Add a "Copy reveal backup" button near the pending-reveal banner that serializes the `CommitmentRecord` to clipboard (JSON), and a paste-to-restore input on the reveal panel that validates + `saveCommitment`s it. Reuse the existing `safeSetItem`/storage helpers. Mirror the same affordance for the bribes-tab `CommitRecord` rows. Keep additive — don't change the commit flow.
- files: `src/components/GaugeVoting.tsx:398-418`, `src/components/community/VoteIncentivesSection.tsx:951-972`
- effort: M
- risk: low
- test: Commit, click Copy reveal backup, clear localStorage, paste to restore, reveal succeeds.
- deps: []

---

## Batch: bribes-zero-state-clarity  (F341)

### F341 — Zero-fee / pending-fee-to-zero / first-voter states render as missing data
- verdict: fix-now
- rootCause: T6 (zero-vs-undefined conflation) + standalone
- confirm: `OverviewStrip` (`:282`) shows `--` when `feeBps > 0` is false → a legit 0% fee reads as no-data. `PendingFeeBanner` (`:163`) returns null when `pending === 0` → a queued cut to 0% is invisible. `GaugeRow`'s `marginalEthPer1k` (`:555`) requires `totalVotes > 0n`, so a bribed gauge with zero votes (the most attractive "first voter takes the pot" state) shows no earn hint.
- approach: (1) `OverviewStrip`: treat fee as loaded-vs-unloaded — pass the raw `bribeFeeBps` plus a `feeLoaded` boolean (from `useBribes`' `globalData[2].status`) and render `0.00%` when loaded-and-zero, `--` only when unloaded. (2) `PendingFeeBanner`: drop the `pending === 0` early-return; only bail when `executeAt === 0` (no pending change). (3) `GaugeRow`: when `summary.ethAmount > 0n && totalVotes === 0n`, render a "first voter takes the full pot" badge instead of suppressing it.
- files: `src/components/community/VoteIncentivesSection.tsx:278-302,160-180,555,578-585`, `src/hooks/useBribes.ts` (expose `feeLoaded`)
- effort: S
- risk: low
- test: Force `bribeFeeBps=0` → strip shows "0.00%". Bribe a zero-vote gauge → "first voter takes the full pot".
- deps: []

---

## Batch: bribes-deposit-step-indicator  (F342)

### F342 — DepositCard approve→deposit two-click flow has no step indicator
- verdict: fix-now
- rootCause: standalone
- confirm: `VoteIncentivesSection.tsx:710-717` `handleSubmit` calls `onApprove` when `needsApproval`; the user must click again after the allowance refetch flips the label (:822-824). The codebase ships an unused `StepIndicator` (`InfoTooltip.tsx:207-249`).
- approach: Render `<StepIndicator steps={['Approve','Deposit']} currentStep={needsApproval ? 0 : 1} />` above the deposit button when `mode==='token'` so the two-step shape is visible upfront. Import from `./ui/InfoTooltip`. Purely additive.
- files: `src/components/community/VoteIncentivesSection.tsx:739-825` (DepositCard), import at top
- effort: S
- risk: low
- test: Select an unapproved ERC20 → indicator shows Approve active; after approval → Deposit active.
- deps: []

---

## Batch: gauge-epoch-duration-label  (F339)

### F339 — Stat card hardcodes "per epoch (7 days)" while EPOCH_DURATION is read from chain
- verdict: fix-now
- rootCause: T3
- confirm: `GaugeVoting.tsx:328` `sub: 'per epoch (7 days)'` is a literal; `:129` reads `EPOCH_DURATION` into `duration` (used for the countdown, not the label). A redeploy with a different duration would mislabel.
- approach: Derive the label: `` sub: `per epoch (${Math.round(duration/86400)} days)` ``. `duration` already in scope.
- files: `src/components/GaugeVoting.tsx:328`
- effort: S
- risk: low
- test: With `EPOCH_DURATION=604800` shows "7 days"; mock a different value → label updates.
- deps: []

---

## Batch: community-tablist-a11y  (F332)

### F332 — Tablist lacks ARIA tabs keyboard pattern + tab/panel wiring; dead selected-state ternary
- verdict: fix-now
- rootCause: T10
- confirm: `CommunityPage.tsx:84-108` — `role="tablist"`/`role="tab"`/`aria-selected` present but no arrow-key roving tabindex, no `id`/`aria-controls` linking tabs to the `role="tabpanel"` (:136), and logged-out there is no tabpanel at all. `:95` `section===key ? 'text-white' : 'text-white hover:text-white'` — both branches identical, so the intended inactive dimming never happens.
- approach: Add ArrowLeft/ArrowRight handling (roving `tabIndex`: active tab `0`, others `-1`), `id={`tab-${key}`}` + `aria-controls={`panel-${section}`}` on tabs and the matching `id`/`aria-labelledby` on the tabpanel. Make the inactive branch `text-white/60`. F322 ensures the tabpanel always renders so `aria-controls` resolves logged-out.
- files: `src/pages/CommunityPage.tsx:80-141`
- effort: S
- risk: low
- test: Keyboard — focus a tab, ArrowRight moves selection; screen reader announces "tab, selected, controls panel". Inactive tabs visibly dimmer.
- deps: [F322]

---

## Batch: gallery-lightbox-polish  (F334, F335)

### F334 — Lightbox doesn't restore focus on close, no swipe, no neighbor preload
- verdict: fix-now
- rootCause: T10
- confirm: `ArtLightbox.tsx:42-74` has a solid focus trap + arrow/Escape, but `onClose` never returns focus to the opener (focus drops to `<body>`, WCAG 2.4.3); no touch/swipe handlers (buttons only); navigation waits on a fresh fetch of the neighbor (no preload).
- approach: (1) Store the opener element — `GalleryPage` passes the triggering card ref, or the lightbox captures `document.activeElement` on open and `.focus()`es it on close. (2) Add pointer/touch swipe (onTouchStart/onTouchEnd delta → handlePrev/handleNext). (3) Preload neighbors: on index change, `new Image().src = pieces[i±1].src`. All additive; don't touch art.
- files: `src/components/ui/ArtLightbox.tsx:34-74,89-103`, `src/pages/GalleryPage.tsx:104,161-162`
- effort: M
- risk: low
- test: Open via keyboard → close → focus returns to the same card. Mobile swipe navigates. Next image appears instantly.
- deps: [F354]

### F335 — Gallery vote affordance hidden when disconnected; live re-sort teleports the voted card
- verdict: fix-now
- rootCause: T7 + standalone
- confirm: `GalleryPage.tsx:138` `{isConnected && (…vote button…)}` hides vote counts entirely without a wallet (social-proof gone). `sortedPieces` re-sorts on every vote (:74-77) so upvoting can teleport a card mid-grid. The card wrapper is `role="button"` (:104) containing the real vote `<button>` (:141) → nested interactive controls in the a11y tree (the :103 comment only avoided literal button-in-button by making the wrapper a div, but role=button + inner button is still nested semantics).
- approach: (1) Show the count always (disabled button + "connect to vote" title when disconnected) — gate only the click. (2) Defer re-sort: compute `sortedPieces` once per mount (snapshot order in a ref) and don't reorder on vote, OR add framer `layout` prop to the card so movement animates legibly. (3) For the nested-control a11y: move the vote button out of the `role="button"` wrapper's interactive subtree — e.g. make the wrapper a plain div with an explicit "open" affordance, or stop `role=button` on the wrapper and rely on an overlay click target that's not an ancestor of the vote button. Keep all art/overlays.
- files: `src/pages/GalleryPage.tsx:73-77,104-151`
- effort: M
- risk: med (sort/interaction change affects the whole grid; verify keyboard + lightbox index still align with `sortedPieces`)
- test: Logged-out shows counts (disabled). Voting doesn't reorder under the cursor (or animates). a11y tree shows no control-in-control.
- deps: []

---

## Batch: gallery-image-perf  (F333, F361, F365)

Shared theme: gallery images pop in late / oversized / lazy above the fold (T12 + perf). One pass over the grid `<img>` + a thumbnail story.

### F333 — All 54 images lazy incl. above-the-fold; 800×800 hint mismatches real aspect ratios (CLS)
- verdict: fix-now
- rootCause: T12
- confirm: `GalleryPage.tsx:117-126` — every card img `width={800} height={800} loading="lazy"`. Lazy on first-viewport images delays LCP; the square hint reserves wrong boxes for non-square pieces so the CSS-columns layout (:101) reflows as each image decodes.
- approach: Eager-load + `fetchpriority="high"` for the first ~6 items (`i < 6 ? 'eager' : 'lazy'`); store real intrinsic `width`/`height` per piece in `artConfig` (`ArtPiece` gains optional `w`/`h`) and use them for the aspect-ratio hint, defaulting to 800×800 only when unknown. Backfill dims incrementally; no art removed.
- files: `src/pages/GalleryPage.tsx:117-126`, `src/lib/artConfig.ts` (ArtPiece type + dims, additive)
- effort: M
- risk: low
- test: Lighthouse — first rows no longer lazy; CLS drops; non-square pieces reserve correct boxes.
- deps: []

### F361 — Fast scrolling shows whole viewports of empty placeholder cells
- verdict: fix-now
- rootCause: T12
- confirm: Live — 3-6 blank dark cards mid-scroll; images pop in with no shimmer/blur-up. Root is the same lazy/`loading="lazy"` config + no placeholder (`GalleryPage.tsx:117-130`).
- approach: Increase the lazy trigger margin (browser-native lazy has a fixed rootMargin, so add a blur-up/shimmer placeholder behind each img — e.g. a CSS shimmer div revealed until `onLoad`, or a tiny LQIP). Combine with F333's eager-first-rows. Reuse the `animate-pulse` skeleton style already used elsewhere.
- files: `src/pages/GalleryPage.tsx:104-130`
- effort: M
- risk: low
- test: Fast-scroll — cells show shimmer then image, no bare dark gaps.
- deps: [F333]

### F365 — Full-resolution images served into ~374px slots; no srcset/thumbnails
- verdict: product-decision
- rootCause: T12 (perf, but needs an asset-pipeline decision)
- confirm: Live DOM — `bobowelie.jpg` natural 1470×2048 shown at 374px (5.5× oversampled); art is single `.jpg` files. Requires generating thumbnails, which is a build/asset decision, not a one-line code fix.
- approach: Decide whether to add a thumbnail pipeline: generate ~600px-wide avif/webp variants for grid cells, keep originals for the lightbox, and emit `srcset`/`sizes` on the grid `<img>`. This is owner/infra scope (asset generation step). Document and queue; the F333 eager/dims work is the no-pipeline interim.
- files: `src/lib/artConfig.ts`, `src/pages/GalleryPage.tsx:117-126`, asset build step (out of repo-code scope)
- effort: L
- risk: low
- test: Grid `<img>` requests ~600px variant; lightbox still loads full-res.
- deps: [F333]

---

## Batch: gallery-content-controls  (F331, F366, F367, F369)

### F331 — Header "54 original hand-drawn pieces" misdescribes the collection (31 are Nakamigos)
- verdict: fix-now
- rootCause: T4
- confirm: `GalleryPage.tsx:88` `{GALLERY_ORDER.length} original hand-drawn pieces from the Tegridy universe`. `GALLERY_ORDER` (`artConfig.ts:276-302`) = 23 Tegridy + naka01–naka31 (titled "Naka #x" / "Fresh from the deck", :46-76) — an external NFT collection, not original Tegridy art.
- approach: Adjust copy additively (owner mandate: keep all art): e.g. "23 original Tegridy pieces plus the Nakamigos drop" or "54 pieces — original Tegridy art and the Nakamigos collection". Pure string change at :88.
- files: `src/pages/GalleryPage.tsx:88`
- effort: S
- risk: low
- test: Header reads accurately; no art changed.
- deps: []

### F367 — Metadata sloppiness: duplicate "Naka #7", inconsistent numbering, copy-paste captions
- verdict: fix-now
- rootCause: T4
- confirm: `artConfig.ts` — `naka03` title "Naka #07" (:48) and `naka31` title "Naka #7" (:76) duplicate; numbering mixes `#01`/`#1`/`#28b` (:46-76); every naka shares "Fresh from the deck"; `swordOfLove` description is just "The sword of love" (:29).
- approach: Normalize naka titles (consistent zero-pad, dedupe the two #7s), and write short unique captions per piece (the lore is the product). Additive metadata edits only — keep every `src`. Coordinate with the owner on the caption voice (Tegridy tone).
- files: `src/lib/artConfig.ts:29,46-76`
- effort: M
- risk: low
- test: No two pieces share a title; captions are unique; grid renders unchanged.
- deps: []

### F366 — No search / filter / sort / category controls for a 54-piece collection
- verdict: fix-now
- rootCause: standalone
- confirm: Live — only artwork buttons + global nav; no inputs on the page. `GalleryPage.tsx` renders a flat sorted grid with no controls. Items mix named pieces and "Naka #NN".
- approach: Add a lightweight control row above the grid: a series filter (Originals / Nakamigos — derivable from id prefix `naka`), a sort (Newest / Most-voted, using the existing `votes` map), and a text filter on title. Reuse the bribes `LeaderboardControls` styling pattern (`VoteIncentivesSection.tsx:495-516`). Filter operates on `GALLERY_ORDER`; keep `sortedPieces` as the source so the lightbox index stays aligned.
- files: `src/pages/GalleryPage.tsx:73-101`
- effort: M
- risk: med (filtering changes the array the lightbox indexes — verify `selectedIndex` maps to the filtered list)
- test: Filter to Nakamigos → only naka cards; search "sunset" → matching pieces; sort by votes works; lightbox opens the right piece.
- deps: [F335]

### F369 — Grid order appears to reshuffle between visits/re-renders
- verdict: fix-now
- rootCause: standalone
- confirm: Live — row 1 changed across scroll-to-top re-render and reload. `sortedPieces` (`GalleryPage.tsx:74-77`) sorts by `votes` which mutates on vote and is read from localStorage at mount; with no votes the order is `GALLERY_ORDER` (stable), but any vote state reorders. (Same root as F335's teleport.)
- approach: Keep a stable default order: sort only as a tiebreaker after the fixed `GALLERY_ORDER` index, or make "sort by votes" an explicit control (ties into F366's sort). Give each piece a `#anchor` / `/gallery/:slug` for relocation (ties into F348 deep-links). Default view = `GALLERY_ORDER` order regardless of votes.
- files: `src/pages/GalleryPage.tsx:74-77`
- effort: S
- risk: low
- test: Reload/re-render keeps row 1 identical; switching the sort control to "Most voted" reorders deliberately.
- deps: [F335, F366]

---

## Batch: stale-prod-redeploy  (F355, F358, F362)

All three are correct at HEAD — prod is a stale build. No code change; ship HEAD.

### F355 — Community page unreachable from nav (orphaned) — live
- verdict: redeploy-only
- rootCause: T1
- confirm: At HEAD `navConfig.ts:33` `PROMOTE_PENDING=true` → `COMMUNITY_LIVE=true`, so the More→Engage menu includes `/community` (`navConfig.ts:89`) and `/gallery` (:90), and the Footer Community column includes `/community` (`Footer.tsx:142-143`). The live agent's prod More menu lacked Community → that build predates the promotion. Code is correct.
- approach: Redeploy prod from HEAD. No code change.
- files: `src/lib/navConfig.ts:33,82-101` (no edit — reference)
- effort: S
- risk: low
- test: After deploy, More→Engage and Footer both list Community.
- deps: []

### F358 — Primary RPC eth.llamarpc.com is down (521 preflights) — live
- verdict: redeploy-only
- rootCause: T1
- confirm: `wagmi.ts:13-19` already demotes llamarpc to last-resort (comment :16 "demoted to last-resort: observed 503/521 in prod") behind `ethereum-rpc.publicnode.com` and `rpc.ankr.com/eth`. The live 521 preflights are from the stale prod build that still tried llamarpc first. Main-app transport is already fixed at HEAD.
- approach: Redeploy prod from HEAD. (Separately note: `nakamigos/components/WhaleIntelligence.jsx:363` and `OnChainProfile.jsx:158` still hardcode `https://eth.llamarpc.com` as a raw `JsonRpcProvider` — that's the Tradermigos sub-app, out of this surface's scope; flag for the g0x Nakamigos plan.)
- files: `src/lib/wagmi.ts:13-19` (no edit — reference)
- effort: S
- risk: low
- test: After deploy, network tab shows publicnode first; no llamarpc on first load.
- deps: []

### F362 — Prod banner promises votes but no voting UI exists — live
- verdict: redeploy-only
- rootCause: T1
- confirm: The vote affordance exists at HEAD (`GalleryPage.tsx:138-150` renders `▲ {votes}` when connected; the "Votes are for fun only" banner at :91-93). Live agent saw the banner with no `▲` on prod → stale build. Dev HEAD already matches the banner.
- approach: Redeploy prod from HEAD. No code change.
- files: `src/pages/GalleryPage.tsx:91-150` (no edit — reference)
- effort: S
- risk: low
- test: After deploy, prod gallery cards show the vote affordance the banner describes.
- deps: []

---

## Batch: global-splash-and-fade  (F363, F371)

Cross-surface (splash + page fade) — affects every page, not just this surface. Owner/global-component scope.

### F363 — Splash screen very long (~18-20s) with no visible skip hint — live
- verdict: product-decision
- rootCause: standalone
- confirm: Not in the Community/Gallery source — it's the global splash component (multi-stage art film, "CLICK TO ENTER" only at the final frame). Owner explicitly values the art ("Keep the art — it's excellent").
- approach: Owner decision: show a persistent "Skip / Click to enter" hint from ~second 1 and consider capping total runtime (~5s) while keeping all art. Implementation lives in the splash component (not this surface). Flag for the global/splash plan; do not edit art.
- files: (global splash component — outside this surface)
- effort: M
- risk: low
- test: First visit shows a skip hint early; clicking enters immediately.
- deps: []

### F371 — Page content fade-in after splash/nav takes ~3-4s and renders text over unloaded art — live
- verdict: fix-now
- rootCause: T12
- confirm: On `/community` the header/tabs animate in (`CommunityPage.tsx:61-71,81-87` framer `opacity 0→1`) before the fixed background `ArtImg` (:55-57, `loading="lazy"`) paints — so text appears at partial opacity over black. Same shape on `/gallery`. The lazy background is the late-paint cause.
- approach: For the page background `ArtImg` on both pages, drop `loading="lazy"` (it's the hero/LCP background) or add a solid color underlay (already `#060c1a` on both) plus a fast (~300ms) fade so content never shows half-transparent over an unpainted background. The solid `#060c1a` is already set, so the main fix is eager-loading the background image and/or shortening the entrance to avoid the half-opacity window.
- files: `src/pages/CommunityPage.tsx:56`, `src/pages/GalleryPage.tsx:83` (gallery bg is solid-only — mainly the entrance timing)
- effort: S
- risk: low
- test: Reload `/community` — background paints before/with the heading; no half-transparent text frame.
- deps: []

---

## Batch: gallery-ultrawide-layout  (F364)

### F364 — Ultrawide: grid capped ~1150px on 1912px viewport (40% dead margins, 3 cols)
- verdict: fix-now
- rootCause: standalone
- confirm: `GalleryPage.tsx:85` container is `max-w-[1200px]`; grid is `columns-1 sm:columns-2 md:columns-3` (:101) — no breakpoint past `md`, so ≥1600px shows 3 columns in a 1200px box. `/community` (`CommunityPage.tsx:59` `max-w-[1200px]`) similarly leaves one narrow card centered.
- approach: For the gallery, widen the container at a new breakpoint and add `xl:columns-4 2xl:columns-5` (Tailwind v4). Keep `/community` at its readable width but consider letting its data tables use more width later (lower priority). Additive CSS only.
- files: `src/pages/GalleryPage.tsx:85,101`
- effort: S
- risk: low
- test: At ≥1600px the gallery shows 4-5 masonry columns with reduced side margins.
- deps: []

---

## Batch: global-mascot-overlap  (F360, F370)

Cross-surface — the Towelie mascot widget is a global overlay, not part of Community/Gallery source. Reference only.

### F360 — Mascot button + tooltip occlude the "Protocol Active" price chip — live
- verdict: fix-now
- rootCause: standalone
- confirm: Not in this surface's source — it's the global mascot/price-chip overlay (bottom-right). Live screenshots show the sprite over the status chip.
- approach: In the global mascot component, stack the mascot above the chip (column layout) or offset the chip left so the price is always readable. Flag for the global-overlay plan; not editable from Community/Gallery files.
- files: (global mascot/status-chip component — outside this surface)
- effort: S
- risk: low
- test: Price chip "$0.0000…" fully visible with mascot + tooltip open.
- deps: []

### F370 — Mascot chat input is tiny and pinned into the corner — live
- verdict: fix-now
- rootCause: standalone
- confirm: Global mascot chat widget (~180px box at the extreme corner, truncated intro). Not in this surface's source.
- approach: In the global mascot chat component, give the panel `min-width ~320px` and anchor it above the mascot. Flag for the global-overlay plan.
- files: (global mascot chat component — outside this surface)
- effort: S
- risk: low
- test: Chat opens as a ≥320px panel above the mascot, intro not truncated.
- deps: [F360]

---

## Batch: global-light-mode-contrast  (F359)

### F359 — Light mode: gallery heading + footer legal links dark-on-dark — live
- verdict: fix-now
- rootCause: standalone (theme)
- confirm: `GalleryPage.tsx:87` heading uses `text-white` + `heading-luxury`; in light mode the page background art stays dark while the theme lightens some surfaces, so a navy/`heading-luxury` foreground can go dark-on-dark. Footer legal links similarly. The `heading-luxury` class and footer link colors come from theme CSS, not inline — the bug is the light palette being applied to text over a persistently-dark art background.
- approach: Keep heading/link foregrounds light wherever the dark art background persists in light mode — i.e. scope the light palette to surfaces that actually lighten, or force `text-white` on these over-art headings regardless of theme. Verify `heading-luxury` and the footer `--color-*` link vars in the theme CSS; the gallery heading and over-dark footer disclaimer should stay light. Touches theme CSS + possibly the footer link style.
- files: `src/pages/GalleryPage.tsx:87`, theme CSS (`src/index.css`/theme tokens), `src/components/layout/Footer.tsx` (disclaimer links)
- effort: M
- risk: med (theme-token change can ripple site-wide; verify dark mode unaffected)
- test: Toggle light mode on `/gallery` — "The Collection" heading readable; `/community` footer "Risk Disclosure · Security" legible.
- deps: []

---

## Batch: community-proposal-lifecycle  (F323)

### F323 — Proposal lifecycle actions missing: no Execute / Cancel / Lapse
- verdict: fix-now
- rootCause: standalone
- confirm: `COMMUNITY_GRANTS_ABI` (`contracts.ts:128-130`) exposes `executeProposal`/`cancelProposal`/`lapseProposal`; `GrantsSection` only wires `voteOnProposal` + `finalizeProposal` (:76-93). Copy says "24h execution delay" (:198) and `STATUS_LABELS` knows Passed/Executed/Lapsed (:16-23), but no UI moves a proposal between states.
- approach: Add status-conditional buttons in the proposal row (`GrantsSection.tsx:299-320`): Execute when `status===1` (Passed) and the execution delay has elapsed (need the proposal's `eta`/delay from `getProposal` — verify the tuple includes it; current destructure at :256-257 has trailing unused fields), proposer-only Cancel on Active, permissionless Lapse on the relevant status. Reuse the existing `_ensureChain` + `writeContract` pattern; add success/refetch via F321.
- files: `src/components/community/GrantsSection.tsx:256-320,76-93`
- effort: M
- risk: med (must read the execution-delay field correctly; wrong gating reverts after gas)
- test: A Passed proposal past its delay shows Execute and it succeeds; proposer sees Cancel on their Active proposal; Lapse appears where valid.
- deps: [F321]

---

## Batch: community-pagination  (F324)

### F324 — Lists capped at latest 10 with no pagination
- verdict: fix-now
- rootCause: standalone
- confirm: `GrantsSection.tsx:51-52` `pageSize=min(count,10); startIdx=max(0,count-pageSize)` reads only the last 10; `BountiesSection.tsx:59-63` same. No load-more/page controls/per-id deep link, so items `#0…#N-11` are unreachable.
- approach: Add a "Load older" cursor that extends the multicall window (increase `pageSize` in steps of 10 via state and rebuild `proposalContracts`/`bountyContracts`), or numbered pagination. Keep the latest-first ordering. Pairs naturally with per-id deep links (F348).
- files: `src/components/community/GrantsSection.tsx:50-74`, `src/components/community/BountiesSection.tsx:58-69`
- effort: M
- risk: low
- test: Create >10 proposals on a fork; "Load older" reveals earlier ids.
- deps: []

---

## Batch: bribes-read-fanout  (F336)

### F336 — Heavy per-render read fan-out; event watchers don't refresh section queries
- verdict: fix-now
- rootCause: T8
- confirm: `VoteIncentivesSection.tsx` per gauge: vote reads @30s (:1062-1065), token list @60s (:1087-1090), per-token amounts @60s (:1109-1115), 10 history epochs @120s (:1133-1136), 5 claimable epochs @60s (:1187-1190); plus `useBribes` 9 global + 6/token @60s. `useBribes.refetchAll` (:294-298) only refetches the hook's own queries, not these section-level `useReadContracts`, which rely solely on intervals. Multicall batches it but it scales linearly with gauge count and runs even when the tab is idle.
- approach: (1) Gate the always-on intervals on document visibility (skip refetch when `document.hidden`) — the prod rate-limiter risk. (2) Make history a per-row on-demand read (only when a row is expanded) instead of fetching 10 epochs × all gauges up front. (3) Pipe the event-watcher refresh through the section queries via `queryClient.invalidateQueries` (give the section reads stable query keys) so peer deposits/claims flush without waiting on the interval. Consolidate where possible into fewer `useReadContracts` keyed by epoch.
- files: `src/components/community/VoteIncentivesSection.tsx:1040-1190`, `src/hooks/useBribes.ts:294-334`
- effort: L
- risk: med (refetch/invalidation rewiring can introduce loops or stale data — verify carefully)
- test: With the tab hidden, no polling; on a peer's deposit the leaderboard updates promptly; history loads only on row expand.
- deps: []

---

## Batch: community-suspense-and-gauge-gate  (F337)

### F337 — Suspense fallback is dead code; gauges tab bypasses FeatureNotDeployed
- verdict: fix-now
- rootCause: T11
- confirm: `CommunityPage.tsx:10-13` imports all sections statically (no `React.lazy`), so the `Suspense` fallback (:143-150) can never render. `:160` `{section==='gauges' && <GaugeVoting/>}` has no page-level `isDeployed` gate; `GaugeVoting` falls back to a bespoke minimal card (:298-308) instead of the standard `FeatureNotDeployed` that grants/bounties/bribes use (:151-159). Bribes is double-gated (page + `VoteIncentivesSection.tsx:1341-1351`, the latter now unreachable).
- approach: Either (a) `React.lazy()` the four section imports so the existing skeleton works, or (b) remove the dead `Suspense` fallback. Prefer (a) for code-split + working skeleton. Gate gauges at the page level: `{section==='gauges' && (isDeployed(GAUGE_CONTROLLER_ADDRESS) ? <GaugeVoting/> : <FeatureNotDeployed pageId="community" idx={4} title=… subtitle=…/>)}` for consistency. Leave the now-redundant inner bribes guard or remove it (low priority).
- files: `src/pages/CommunityPage.tsx:10-13,151-161`
- effort: S
- risk: low
- test: Throttle — switching tabs shows the skeleton; with gauge controller undeployed, gauges shows the standard SOON panel matching the other tabs.
- deps: []

---

## Batch: bounties-submission-funnel  (F316, F351)

### F316 — Bounty funnel broken end-to-end: no view/vote/complete/cancel/refund UI
- verdict: fix-now
- rootCause: standalone
- confirm: `MEME_BOUNTY_BOARD_ABI` (`contracts.ts:137-151`) exposes `voteForSubmission`, `getSubmission`, `submissionCount`, `completeBounty`, `cancelBounty`, `refundStaleBounty`, `hasVotedOnBounty` — **none** used in `BountiesSection` (only `createBounty`, `submitWork`, `withdrawPayout/Refund`, `getBounty`). Card copy "Community votes on submissions. Winner takes the reward." (:181) and rows show "{n} submissions" (:247), but submissions can't be listed/voted/finalized — no winner without raw Etherscan.
- approach: Build out the expanded-row submissions list: read `getSubmission × submissionCount(bountyId)` (multicall), render each with its `contentURI` (link, sanitized via the existing `isAllowedSubmissionUri`) and vote count; add Vote buttons (`voteForSubmission`, gated by `hasVotedOnBounty`), a Complete button (creator/conditions), creator Cancel (`cancelBounty`), and permissionless `refundStaleBounty`. Reuse `_ensureChain` + write/refetch (F321). This is the bulk of the bounty feature; sizeable.
- files: `src/components/community/BountiesSection.tsx:227-291` (expanded row), new submission-read block
- effort: L
- risk: med (multiple new writes on the bounty money path)
- test: On a fork: submit work → it appears in the list → vote → Complete picks the winner → payout claimable. Cancel/refund paths work.
- deps: [F321, F329]

### F351 — Bounty board basics vs grants/quest platforms (submission gallery, voting, winner, filters, my-bounties)
- verdict: duplicate
- rootCause: standalone
- confirm: This "missingVsBestInClass" item is the product framing of F316 (submission gallery/voting/winner) plus status filters (Open/Completed/Expired) and a my-bounties view. The submission/voting/winner half is exactly F316.
- approach: Core (submission gallery, voting, winner display) lands with F316. Remaining extras — status filters and a "my bounties" view — are a small follow-on on top of the F316 list (filter by `status` from `getBounty`; filter by `creator===address`). Treat the extras as a thin add-on to F316's PR.
- files: `src/components/community/BountiesSection.tsx`
- effort: M
- risk: low
- test: Status filter chips work; my-bounties shows only the connected creator's bounties.
- deps: [F316]

---

## Batch: bribes-claim-all  (F346)

### F346 — Claim-all across gauges in one tx
- verdict: product-decision
- rootCause: standalone
- confirm: `claimBribesBatch` exists per gauge (`useBribes.ts:169-179`; used in `handleClaim` :1270-1278) but only batches epochs for ONE pair. A voter with 4 gauges clicks Claim 4 times. There is no cross-gauge claim-all in the ABI (no multi-pair claim function found).
- approach: Owner/contract decision — a true one-tx claim-all needs a contract function (multi-pair) that may not exist. Interim frontend-only option: a "Claim all" button that fires the per-gauge claims sequentially (N wallet prompts), which is a UX improvement but not one tx. Flag the contract-level multicall as a product decision; ship the sequential helper if acceptable.
- files: `src/components/community/VoteIncentivesSection.tsx:1386-1393` (ClaimablesPanel header), `src/hooks/useBribes.ts`
- effort: M
- risk: low
- test: "Claim all" fires claims for every claimable gauge.
- deps: []

---

## Batch: community-deep-links  (F348)

### F348 — Per-entity deep links (?gauge= / ?proposal= / ?bounty= / #anchors)
- verdict: fix-now
- rootCause: standalone
- confirm: Live + grep — no `?gauge=`/`?proposal=`/`?bounty=` params or item anchors; items can't be shared/linked. `CommunityPage` only reads `?section=`.
- approach: Extend the existing `useSearchParams` pattern (`CommunityPage.tsx:39-50`): read optional `?proposal=`/`?bounty=`/`?gauge=` and scroll-to/expand the matching item on mount (proposals/bounties already keyed by id; gauges by pair). Add a small "copy link" affordance per row. Pairs with pagination (F324) so a deep-linked old item loads. Gallery per-piece permalink ties to F369's `/gallery/:slug`.
- files: `src/pages/CommunityPage.tsx:39-50`, `src/components/community/GrantsSection.tsx`, `BountiesSection.tsx`, `GaugeVoting.tsx`
- effort: M
- risk: low
- test: `/community?section=bounties&bounty=12` scrolls to/expands bounty #12; copy-link round-trips.
- deps: [F324]

---

## Batch: bribes-usd-and-roi  (F344, F353)

### F344 — USD values everywhere (bribes/claimables/emissions/TVL only in ETH/raw tokens)
- verdict: product-decision
- rootCause: standalone
- confirm: "missingVsBestInClass" — the section denominates everything in ETH/raw tokens (e.g. `GaugeRow` ETH bribe :601, marginal earn :583) with no `$ per vote`, `$/veTOWELI`, or projected APR. THE headline number on Hidden Hand/Votium.
- approach: Owner decision + dependency on a price oracle/feed. There IS a `formatCurrency` helper (`formatting.ts:3-12`) and the app surfaces a TOWELI price elsewhere (mascot chip). Decide whether to wire a price source (TOWELI + ETH USD) into the bribes section to show `$` per vote and per-gauge APR. Real value but needs the price plumbing decision (and the deep-pool/TWAP oracle per project memory). Flag, don't build blind.
- files: `src/components/community/VoteIncentivesSection.tsx` (GaugeRow + strip), price hook
- effort: L
- risk: med
- test: Each gauge shows `$X / 1k voted` and an APR; values track the price feed.
- deps: []

### F353 — Voting-power acquisition funnel: no inline ROI calculator
- verdict: product-decision
- rootCause: standalone
- confirm: The bribes tab links to `/farm` to stake (`VoteIncentivesSection.tsx:331-336`) but has no "how much would X TOWELI staked earn from current bribes" calculator (Votium-style).
- approach: Same dependency as F344 (needs $ values / APR). Once USD/APR is decided, add an inline calculator near the VotingPowerBanner. Flag together with F344.
- files: `src/components/community/VoteIncentivesSection.tsx:305-360`
- effort: M
- risk: low
- test: Enter a stake amount → projected bribe earnings from current pots.
- deps: [F344]

---

## Batch: bribes-history-explorer  (F345)

### F345 — Round/epoch history explorer (per-round archives)
- verdict: product-decision
- rootCause: standalone
- confirm: Only a "lifetime ~ETH" micro-label per gauge (`VoteIncentivesSection.tsx:602-604`); no past-epoch table (who bribed what, total paid, your earnings/claim history). Hidden Hand/Votium expose per-round archives.
- approach: Substantial feature. The section already reads `HISTORY_LOOKBACK_EPOCHS` of ETH totals (:1117-1136) — could be extended into an expandable per-epoch table, but a full archive (per-depositor, per-token, claim history) likely wants an indexer (Dune/subgraph per project memory) rather than live multicall. Owner decision on indexer vs. on-chain lookback depth. Flag.
- files: `src/components/community/VoteIncentivesSection.tsx`, indexer
- effort: L
- risk: low
- test: A past-epoch table lists bribes/totals/your earnings per round.
- deps: []

---

## Batch: snapshot-integration  (F347)

### F347 — Snapshot integration entirely absent (no space link / delegation / mirror)
- verdict: product-decision
- rootCause: standalone
- confirm: Repo-wide grep confirms no snapshot.org space link, delegation UI, or off-chain proposal mirror. The roadmap's Tier-1 "Snapshot delegation" item (project memory) has no surface here.
- approach: Owner/product scope — needs a Snapshot space + delegation contract decision. Minimal first step (frontend-only, Tier-1 per memory): add a Snapshot space link and a delegation CTA. Flag for product; not a code-only fix without the space/contract.
- files: `src/pages/CommunityPage.tsx` (new tab or banner)
- effort: L
- risk: low
- test: Snapshot link/delegation flow present.
- deps: []

---

## Batch: tx-simulation-preview  (F350)

### F350 — Tx simulation/preview + gas context before writes
- verdict: product-decision
- rootCause: standalone
- confirm: "missingVsBestInClass" — votes/deposits/claims fire with no expected-outcome panel beyond the bribe earn estimate (`GaugeRow` projectedEarn :653-656). No `simulateContract`/gas preview.
- approach: Owner decision. Could add wagmi `useSimulateContract` previews + gas estimates before the major writes (deposit/claim/vote). Cross-surface pattern (applies app-wide), so coordinate as a shared "tx preview" component rather than bespoke per section. Flag.
- files: section write call sites; shared preview component
- effort: L
- risk: low
- test: Each write shows a simulated outcome + gas before signing.
- deps: []

---

## Batch: community-notifications  (F349)

### F349 — Notifications/alerts (unclaimed-bribes badge, reveal-deadline reminder, push/email)
- verdict: product-decision
- rootCause: standalone
- confirm: No nav badge for unclaimed bribes, no reveal-deadline reminder (bond forfeiture is time-critical), no push/email. The data exists (claimables computed in-section; reveal windows tracked) but isn't surfaced as alerts.
- approach: Owner/infra scope (push/email needs a backend per the roadmap's "push alerts" Tier-1 item). Frontend-only first step: a nav badge when `claimables.length > 0` and an in-page reveal-deadline countdown emphasis (the reveal window is already computed). Push/email is backend. Flag; ship the in-app badge if approved.
- files: nav/header, `src/components/community/VoteIncentivesSection.tsx`
- effort: L
- risk: low
- test: Nav shows an "unclaimed" badge when the connected user has claimables.
- deps: []

---

## Batch: gallery-missing-vs-bestinclass  (F352)

### F352 — Gallery vs OpenSea/Blur galleries (sort/filter/search, permalink/share, full-res/download, pinch-zoom, swipe)
- verdict: duplicate
- rootCause: standalone
- confirm: This "missingVsBestInClass" item decomposes entirely into already-planned findings: sort/filter/search = F366; per-piece permalink/share = F348/F369; swipe + (preload) = F334; full-res view = the lightbox already shows the original (`ArtLightbox.tsx:95`, `width=1600`). The only genuinely net-new asks are download and pinch-zoom.
- approach: Covered by F366 (controls), F348/F369 (permalinks), F334 (swipe). Net-new bits — a download button and pinch-zoom in the lightbox — are small additive enhancements to `ArtLightbox` (add a download `<a download>` and a pointer-pinch handler). Roll the two net-new bits into the F334 lightbox-polish PR.
- files: `src/components/ui/ArtLightbox.tsx`
- effort: M
- risk: low
- test: Lightbox has download + pinch-zoom; the rest verified under F366/F348/F334.
- deps: [F334, F366, F348]
```
