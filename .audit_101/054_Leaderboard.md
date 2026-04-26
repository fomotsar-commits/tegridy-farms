# Agent 054 — Leaderboard / Points / Tegridy Score Forensic Audit

Scope: `frontend/src/pages/LeaderboardPage.tsx`, `frontend/src/lib/pointsEngine.ts`,
`frontend/src/hooks/usePoints.ts`, `frontend/src/components/TegridyScore.tsx`,
`frontend/src/components/TegridyScoreMini.tsx`, `frontend/src/hooks/useTegridyScore.ts`,
plus cross-check of `frontend/src/lib/pointsEngine.test.ts`.

Read-only forensic audit. No code modified.

---

## Counts

- HIGH: 4
- MEDIUM: 6
- LOW: 5
- INFO: 4
- Total: 19

---

## HIGH

### H1 — Client-computed scores are the source of truth (trivially gameable)
**File:** `pointsEngine.ts:169-189`, `useTegridyScore.ts:340-380`, `usePoints.ts:99-104`

`computeOnChainPoints()` and `useTegridyScore`'s aggregator both run in the
browser. While the *inputs* (stake, LP balance, swap-count log scan, referral
count, vote count, bounty count) are read from chain via wagmi/viem, the
*scoring formula and weights* are client-side. Any user can:
1. Edit `WEIGHTS` and `breakpoints` in DevTools and reload — the displayed
   score, rank, badges, and tier change immediately.
2. Patch `getStreakMultiplier`, `clampPoints`, or `MAX_POINTS` to inflate
   their displayed score.
3. Spoof `useReadContracts` results via wagmi cache to fabricate a
   100-point Tegridy Score for screenshots / fake-flex on Twitter.

The page banner ("On-Chain Verified Points") and `<TegridyScoreMini>` text
("On-chain verified") **misrepresent the trust model** — the inputs are
on-chain but the score itself has zero cryptographic verification. This
matches the user-facing comment at `usePoints.ts:151-153` ("not
cryptographically verified") but contradicts the marketing copy in
`LeaderboardPage.tsx:41` and `TegridyScoreMini.tsx:85`.

**Severity rationale:** if any future airdrop / NFT mint / reward gate
references "Tegridy Score" or "Points" off this client computation, it is a
direct theft vector. The pointsEngine top-of-file comment acknowledges this
("Any future airdrop or reward distribution MUST use on-chain data
exclusively") — flagged here because the marketing copy on the page does not.

### H2 — Self-referral self-credit possible via `incrementReferralCount`
**File:** `pointsEngine.ts:241-249`, `usePoints.ts:106-118`

`incrementReferralCount(referrerAddress)` writes `referralCount + 1` and adds
points to localStorage with **no check that the referrer != referee**. The
guard exists in `setReferrer()` (line 233) but not in `incrementReferralCount`.
Combined with the `?ref=` URL param consumed in `usePoints.ts:106-118`, a user
can:
1. Open `https://app/?ref=0xSelf` in two tabs / multiple wallets.
2. Each call to `incrementReferralCount` boosts their own localStorage
   referralCount up to the 10,000 cap.
3. Bypassed by the on-chain reconciliation in current `usePoints` (line 95
   reads `onChainReferralCount` from `REFERRAL_SPLITTER`), but the localStorage
   value is still read by stale paths, can corrupt the integrity hash, and is
   surfaced in `points.data.referralCount` displayed at `LeaderboardPage.tsx:140`.

**Severity:** localStorage-only abuse becomes critical the moment a future
feature trusts `data.referralCount` for eligibility.

### H3 — Sybil protection completely absent
**File:** `pointsEngine.ts` (whole), `useTegridyScore.ts` (whole)

No wallet-uniqueness or sybil heuristics anywhere:
- No proof-of-humanity, gitcoin passport, or social linkage check.
- No "minimum age" filter beyond the loyalty-score timestamp (which is
  *additive*, not gating).
- `referralCount` is per-wallet — a sybil farmer with N wallets earns
  N×referral points and N×activity scores trivially.
- The `WEIGHTS.community` (15%) and `WEIGHTS.governance` (15%) are easily
  pumped by self-referrals + spam-voting from a wallet farm.

**Severity:** baseline systemic risk for any leaderboard claiming integrity.

### H4 — `localStorage` integrity hash uses djb2 (not crypto), nonce defeated
**File:** `pointsEngine.ts:62-106`

The integrity hash is a 32-bit djb2 (`computeHashSync`) prefixed `s1_`. The
"per-session nonce" stored in module-scope `sessionNonce` is **regenerated
every page load** (line 67), meaning the *legitimate* code only verifies the
cache against the same-load nonce. The integrity check is therefore
effectively useless:
- Attacker opens DevTools, runs the same djb2 over their tampered payload
  using `getSessionNonce()` from window scope (the function isn't exported but
  is reachable through the module's closure if a debugger pause is set, or
  trivially recreated — djb2 takes 5 lines).
- Even without DevTools: simply *clearing* the integrity key forces a fall
  through to `FRESH_DATA()`, but writing a new `(payload, hash)` pair takes 2
  console statements with the in-memory nonce.
- The 16-byte nonce is held in JS heap, accessible via `window.crypto`
  patches or Sources panel breakpoints.

**Severity:** the comment at line 64-66 admits this is defense-in-depth, but
the LeaderboardPage banner sells it as verified. Honesty gap.

---

## MEDIUM

### M1 — Misleading "On-Chain Verified" copy
**File:** `LeaderboardPage.tsx:41-42`, `TegridyScoreMini.tsx:85`

Banner says *"On-Chain Verified Points / All points are now derived
exclusively from on-chain activity"* yet `LeaderboardPage.tsx:185` says
*"Points are local and unverified."* Two messages on the same page contradict
each other. `TegridyScoreMini` shows "On-chain verified" to non-connected
users with no qualifier. Pick one truth.

### M2 — `setReferrer` accepts unchecksummed referrer in storage
**File:** `pointsEngine.ts:232-239` + `usePoints.ts:111-116`

`usePoints` does call `getAddress()` to checksum the URL param before passing
to `setReferrer`, but `setReferrer` itself accepts arbitrary strings. Other
callers (currently none, but easy to add) could write garbage to the
`referrer` field, which is then echoed unchanged in derived flows. Defense
should live in `setReferrer`, not the call site.

### M3 — Wide `eth_getLogs` scan from block 18,000,000 to latest, every page load
**File:** `usePoints.ts:67-85`, `useTegridyScore.ts:300-338`

Two `getLogs` calls scan from block 18,000,000 to `'latest'`:
1. `SwapExecuted` for swap-count.
2. `Staked` for first-interaction (this one *is* cached to localStorage —
   good).

The swap-count scan has **no caching** and runs on every connection / address
change. On public RPCs that cap log range (Alchemy = 2k blocks free tier,
Infura = 10k, public Base RPCs vary) this will:
- Frequently fail silently (catch sets count=0 → user sees "0 swaps", missing
  badges/points).
- Pound RPC quotas, leading to UX brownouts.
Recommendation: introduce a Ponder/subgraph indexer (the page banner already
promises one) or at minimum cache the count + most-recent-block-scanned in
localStorage and only scan the delta.

### M4 — Loyalty timestamp cache trusts localStorage without integrity check
**File:** `useTegridyScore.ts:290-298, 329`

`firstInteractionTs` is cached in plain localStorage (no hash, no nonce). A
user can write `localStorage.setItem('tegridy-score:first-interaction:0x...',
'1577836800')` (Jan 1 2020) and the loyalty score immediately reads as 100,
worth 10 points (10% weight) of the displayed Tegridy Score. Compared to the
djb2 dance for the points cache, this one is naked.

### M5 — Vote / proposal / bounty enumeration has hard cap of 50 (off-by-one risk + silent truncation)
**File:** `useTegridyScore.ts:205, 261`

`Math.min(proposalCount, 50)` and `Math.min(bountyCount, 50)`: addresses with
votes / bounties on proposal IDs >50 get **zero credit** for them. No warning
in the UI. The "Tip: Vote on grant proposals" still fires even when the user
has voted on 49 proposals at IDs 51-99.

Also the `for (let i = 0; i < count; i += batchSize)` pattern with
`Math.min(batchSize, count - i)` is technically correct but worth re-asserting
in tests (none exist for `useTegridyScore`).

### M6 — `usePoints` `useEffect` overwrites `onChainPoints` field after `reconcilePoints` already wrote storage
**File:** `usePoints.ts:99-103`

```ts
const onChainPts = computeOnChainPoints(metrics);
const reconciled = reconcilePoints(address, onChainPts);
reconciled.points = onChainPts;  // overwrites streakBonus add from line 196
```

`reconcilePoints` adds `streakBonus` to `data.points` and persists with the
integrity hash. Then the next line stomps `reconciled.points` back to
`onChainPts` *only in the React state*, leaving an inconsistency between
storage (with bonus) and runtime (without bonus). Subsequent page reloads
read storage → see bonus → display higher than runtime computation. Flicker
+ confusion. Likely a dead-code remnant from removing client streaks.

---

## LOW

### L1 — No address truncation safety / formatting bug surface
**File:** `LeaderboardPage.tsx:137`

The referral link is rendered with `truncate flex-1` CSS class. Functional,
but if a future change displays a leaderboard list of `0x...` addresses
*without* CSS truncation, `0xa1b2c3...` ↔ `0xa1b2c3...` collisions are
visually possible. **No address-collision-resistant short-form helper exists
in the codebase** (no `shortenAddress(addr)` utility imported anywhere here).
Add one before shipping a leaderboard table.

### L2 — Avatar URL not used here, but `ArtImg` doesn't validate origin
**File:** `LeaderboardPage.tsx:36, 65, 151, 165, 193, 213` (and `ArtImg` itself)

The page renders `<ArtImg pageId="leaderboard" idx={N} />` without anything
user-controlled. Once a real leaderboard ships, expect to render
user-provided avatars (ENS, NFT, etc.) — there's currently **no
url-allowlist helper** in the audited files. Flag for the leaderboard-table
PR.

### L3 — No search box yet → no query-injection risk *today*
**File:** `LeaderboardPage.tsx` (search)

Page has zero search inputs. INFO/LOW because the directive expected one;
search injection N/A in current state. When a search input lands, it MUST
sanitize (no eval/innerHTML), and any subgraph query must use parameterized
GraphQL (not string-concat).

### L4 — Pagination off-by-one — N/A today
No pagination component on the page. INFO/LOW. When ranking pagination
lands, the `Math.min(count, 50)` pattern in `useTegridyScore.ts` is the
canary — convert to a proper page-iteration helper with explicit
`(page-1)*size, page*size` math and an exclusive upper bound.

### L5 — No rate-limiting on point-claim hooks
**File:** `usePoints.ts:120-124` (`logAction` callback)

`logAction` is exposed to consumers and writes localStorage on every call.
If a future call site loops `logAction` (e.g., after every keypress in a
reward modal), there is no debounce / per-action cooldown. `recordAction`
itself is now a no-op (deprecated, line 222), so today no points are added —
but the callable surface still mutates state and triggers React re-renders.
Either remove `logAction` from the public hook return or add a no-op note.

---

## INFO — pointsEngine.test.ts coverage gaps

The test file covers **only 5 happy-path inputs** to `computeOnChainPoints`
plus 4 to `getStreakMultiplier` and 5 to `getTier`/`getNextTier`.

**Not asserted:**
1. **Negative / NaN / Infinity inputs** — `clampPoints` is never tested with
   `NaN`, `-1`, `Infinity`. Coverage of line 110 is zero.
2. **Overflow caps** — `MAX_POINTS = 1_000_000`, `MAX_STREAK = 365`, the
   100,000 swap cap (line 172), the 10,000 referral cap (line 186), the 1,460
   stake-day cap (line 176), the 200 LP score cap (line 183), and the
   1,000,000 lpToken bigint cap (line 182) — **none are hit by any test**.
3. **`safeBigintToNumber` overflow** — the bigint > Number.MAX_SAFE_INTEGER
   branch (line 117) is unreachable in tests.
4. **`reconcilePoints`** — entire function untested. Streak bonus
   accumulation, persistence, integrity hash all uncovered.
5. **`getPointsData` / `savePointsData` round-trip** — cache miss, integrity
   failure, JSON parse error, validation failure (`validatePointsData`
   returning false) — **all uncovered**.
6. **`validatePointsData`** — every guard branch (non-object, missing
   field, wrong type, points<0, points>MAX, streak>MAX) untested.
7. **`incrementReferralCount`** — untested, so the self-referral bug in H2
   has no regression net.
8. **`setReferrer`** — self-referrer guard (line 233) untested.
9. **`getEarnedBadges`** — entire badge-evaluation matrix untested. None of
   the 9 BADGES `check()` predicates are exercised.
10. **`computeHashSync` / nonce / `verifyCacheIntegrity`** — untested. The
    hash check at H4 is plausibly broken with no test asserting that
    tampering flips the integrity bit.
11. **`getNextTier` at exactly Diamond min (5,000)** — passes (returns null)
    but boundary just-above (4,999) untested.
12. **Action-array trimming to MAX_ACTIONS=100** in `incrementReferralCount`
    (line 247) — untested.

**INFO — `useTegridyScore` and `usePoints` have zero hook-level tests.**
The `useTegridyScore.ts` math is the entire premise of the page; not a
single test file covers `calcStakingScore`, `calcLockScore`,
`calcActivityScore`, `calcGovernanceScoreFromChain`,
`calcCommunityScoreFromChain`, `calcLoyaltyScoreFromTimestamp`, `getRank`,
`getTier`, or `getTips`. Pure functions, easy to unit-test, none are.

---

## Top 3 (prioritized)

1. **H1** — Marketing copy says "on-chain verified" but the score formula
   runs in the browser. Either (a) move the score reduction to a
   contract/indexer + signed read, or (b) change the copy to "your local
   tally of on-chain activity — not cryptographically verified."
2. **H2** — `incrementReferralCount` lacks the self-referral guard that
   `setReferrer` already has. One-line fix; high blast radius if any future
   reward gate trusts `data.referralCount`.
3. **H4 + M4** — localStorage integrity is *theatre*. Either drop the
   integrity hash entirely (it adds zero security and creates dead complexity
   + future-self confusion) or replace with a server-signed HMAC. The
   loyalty-timestamp cache is naked localStorage with no guard at all and is
   worth 10% of the visible score.

---

*Forensic audit only. No files modified. End of agent 054 report.*
