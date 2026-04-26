# Audit 067 — Lib: Points Engine, Boost Calculations, Towelie Knowledge

Agent: 067 / 101 | Audit-only forensic review.

Targets:
- `frontend/src/lib/pointsEngine.ts`
- `frontend/src/lib/pointsEngine.test.ts`
- `frontend/src/lib/boostCalculations.ts`
- `frontend/src/lib/towelieKnowledge.ts`

Cross-checked against:
- `frontend/src/lib/constants.ts`
- `frontend/src/hooks/useNFTBoost.ts`
- `contracts/src/TegridyStaking.sol`
- `contracts/src/TegridyLPFarming.sol`
- `contracts/src/TegridyPair.sol`
- `contracts/src/TegridyRouter.sol`
- `contracts/src/Toweli.sol`
- `frontend/src/components/TowelieAssistant.tsx`

Counts: HIGH 0 | MEDIUM 5 | LOW 4 | INFO 4 (total 13)

---

## MEDIUM-1 — Towelie KB contradicts on-chain truth: "100% of swap fees flow back to stakers"

File: `frontend/src/lib/towelieKnowledge.ts:22, 122`

> "TOWELI is the farm's token. 1B fixed supply. **100% of swap fees flow back to stakers as ETH**. That's the whole pitch."
> "Swap fee is 0.3% per trade. **100% of it goes to TOWELI stakers as ETH**."

On-chain truth (`contracts/src/TegridyPair.sol:15-17, 302-303`):
- 5/6 (~0.25%) goes to LPs (via accumulated reserves)
- 1/6 (~0.05%) goes to protocol (feeTo address)

LPs receive the majority; only ~16.7% of fees route to the protocol's feeTo (which then funds revenue distribution). The "100% of swap fees flow back to stakers" claim is materially false. This is a misrepresentation that could expose the project to disclosure risk — both LPs and stakers receive partial allocations, and a portion may also accrue to treasury, depending on how SwapFeeRouter / RevenueDistributor are wired.

Impact: Reputational + potential securities/marketing-claim exposure.
Fix: Restate as "swap fees flow to LPs and TOWELI stakers — see /tokenomics" or precise BPS split. Cross-reference SwapFeeRouter destination wiring before publishing exact numbers.

---

## MEDIUM-2 — Towelie KB false claim: "early withdrawal penalty scales with how far from unlock"

File: `frontend/src/lib/towelieKnowledge.ts:60-61`

> "Withdraw early = penalty (% scales with how far you are from your unlock date). Wait it out for the full payout."

On-chain truth (`contracts/src/TegridyStaking.sol:36, 56`, `frontend/src/lib/constants.ts:88`):
- `EARLY_WITHDRAWAL_PENALTY_BPS = 2500` — flat 25%, never scales.

Users will plan exits based on a non-existent gradient and be hit with a much larger penalty than they expect at near-unlock dates (or smaller than expected at fresh locks).

Impact: User funds lost / surprise; trust hit.
Fix: Update copy to "flat 25% penalty regardless of remaining lock duration. Treasury keeps it (or recycles to active stakers if penaltyRecycleBps > 0)."

---

## MEDIUM-3 — Towelie KB misleading claim: "Stack JBAC NFTs for stacked boost"

File: `frontend/src/lib/towelieKnowledge.ts:142`

> "JBAC NFTs add a boost multiplier on top of your lock boost. Hold one, your stake earns more. **Stack them for stacked boost.**"

`frontend/src/hooks/useNFTBoost.ts:35-38` and `constants.ts:87` show:
- `JBAC_BONUS_BPS = 5000` — flat +0.5x on hold-any. No additive stacking; `holdsJBAC ? 1.5 : 1`.

Holding 10 JBAC gives the same boost as holding 1. Telling users to "stack them for stacked boost" is consumer-facing fraud-bait — they may purchase additional NFTs based on this claim.

Impact: Could induce purchase decisions on a false premise. Reputational + potential consumer-claim exposure.
Fix: "JBAC NFT gives +0.5x boost (1.5x total). Holding more than one gives no extra boost — it's a flat bonus."

---

## MEDIUM-4 — Boost ceiling claim contradicts on-chain MAX_BOOST_BPS_CEILING

File: `frontend/src/lib/towelieKnowledge.ts:88`

> "Boost = 0.4 + 3.6 × (lock_remaining / max_lock), clamped to **0.4x–4.0x** between 7-day and 4-year locks."
> "Lock from 7 days to 4 years. **4 years = 4× boost** on rewards."

On-chain (`contracts/src/TegridyLPFarming.sol:65-70`):
- `MAX_BOOST_BPS_CEILING = 45000` (4.5x) — explicitly accommodates max-lock + JBAC bonus.

The KB entry under "math" omits the JBAC additive path. Combined with MEDIUM-3, users believe ceiling is 4.0x even with JBAC, when on-chain LP farming clamps at 4.5x. Contradicts the audit C-01 redeploy comment in `constants.ts:19`.

Impact: Yield calculator inaccuracy; user disappointment OR underestimation.
Fix: "Effective LP boost = stake-lock boost × JBAC bump, capped at 4.5x on-chain (LP farming MAX_BOOST_BPS_CEILING)."

---

## MEDIUM-5 — `incrementReferralCount` has no idempotency key — replay vector if wired up

File: `frontend/src/lib/pointsEngine.ts:241-249`

```ts
export function incrementReferralCount(referrerAddress: string) {
  const data = getPointsData(referrerAddress);
  data.referralCount = Math.min(data.referralCount + 1, 10_000);
  const referralPts = POINTS_MAP.referral_swap ?? 0;
  data.points = clampPoints(data.points + referralPts);
  data.actions.push({ type: 'referral_swap', pts: referralPts, ts: Date.now() });
  ...
}
```

- No txHash / event-id deduplication. Two calls = two credits, regardless of whether the same on-chain referral event triggered them.
- No server reconciliation hint (no nonce, no event signature, no log index).
- Despite the file's "on-chain is authoritative" claim, this function silently increments a localStorage points cache that the UI displays as authoritative until a fresh `reconcilePoints` runs.
- Currently dead code (no callers in the repo: confirmed via grep), but still exported. If a future wire-up calls it from a router-event handler, replay is trivial — re-render = re-credit.

Impact: Latent. If/when wired, points leaderboard becomes trivially gameable client-side.
Fix: Either delete `incrementReferralCount` (preferred — same treatment as `recordAction`/`recordDailyVisit` which were neutered to no-ops) or require an event-id arg and de-dupe via `data.actions.some(a => a.eventId === id)`.

---

## LOW-1 — `verifyCacheIntegrity` always fails after page reload (per-session nonce)

File: `frontend/src/lib/pointsEngine.ts:67-77, 98-106`

The session nonce is regenerated on every page load (in-memory `sessionNonce`). The integrity hash is persisted to localStorage. On the next reload, `computeHashSync` hashes the stored raw with a NEW nonce, so the comparison NEVER matches the old hash. Result: `getPointsData` always returns `FRESH_DATA()` after reload.

This isn't exploitable — actually fail-safe — but the cache is effectively never used cross-session. Either intended (matches the deprecation of `recordDailyVisit`) or a logic bug. Comment on lines 63-65 says cache is for "between sessions" — that intent is broken.

Fix: If cross-session caching is desired, derive nonce from a stable but not-attacker-known seed (e.g., user signature). Otherwise, document that cache is intentionally session-scoped and remove the misleading "between sessions" comment in the file header (lines 5-6).

---

## LOW-2 — `calculateBoost` silently returns MIN_BOOST for invalid (sub-min) inputs

File: `frontend/src/lib/boostCalculations.ts:3-10`

```ts
if (durationSec <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
```

- Zero, negative, NaN-coerced, and `<= MIN_LOCK_DURATION - 1` all return `MIN_BOOST_BPS` (4000 = 0.4x).
- On-chain `TegridyStaking.sol:512` REVERTS with `LockTooShort` for `_lockDuration < MIN_LOCK_DURATION`.
- A UI that uses `calculateBoost` to display "your boost will be 0.4x" for a 1-day lock will mislead users — the actual stake tx will revert.
- Tested via repro: `calculateBoost(0)` → 4000, `calculateBoost(-1000)` → 4000, `calculateBoost(MIN_LOCK_DURATION)` → 4000. Last is on-spec; the first two should arguably throw or return 0.

Fix: Add input validation:
```ts
if (!Number.isFinite(durationSec) || durationSec < MIN_LOCK_DURATION) {
  // Match on-chain behaviour — caller should not display this boost
  return 0; // or throw 'lock too short'
}
```
Note that on-chain accepts `==` MIN_LOCK_DURATION (line 512: `<` only reverts), so frontend is correct to return MIN_BOOST at `==` MIN. The off-by-one is benign for the boundary itself; the issue is the silent floor below it.

---

## LOW-3 — `boostCalculations.ts` lacks a test file

File: `frontend/src/lib/boostCalculations.ts` — confirmed via Glob: no `boostCalculations.test.ts`.

Critical reward-math function with zero unit-test coverage. Boundary, overflow, and integer-rounding cases unverified. With on-chain math being the source of truth, divergence between contract and frontend slowly creeps.

Fix: Add a test mirroring `pointsEngine.test.ts` shape covering: 0, MIN-1, MIN, MIN+1, midpoint, MAX-1, MAX, MAX+1, NaN, negative, very-large.

---

## LOW-4 — `pointsEngine.test.ts` doesn't cover validation / clamping / cache integrity

File: `frontend/src/lib/pointsEngine.test.ts`

Only 4 functions are tested (`computeOnChainPoints`, `getStreakMultiplier`, `getTier`, `getNextTier`). Untested:
- `validatePointsData` (security-critical)
- `clampPoints`
- `safeBigintToNumber`
- `verifyCacheIntegrity`
- `reconcilePoints` (which actually mutates storage)
- `incrementReferralCount`
- `getEarnedBadges`

In particular, `validatePointsData` is the only barrier between attacker-supplied JSON in localStorage and corrupted state. No coverage means a regression in this guard could be silent.

Fix: Add test cases for:
- Negative `points`
- `points > MAX_POINTS`
- `streak.current > MAX_STREAK`
- Non-array `actions`
- Missing `streak`
- Non-finite numbers (NaN, Infinity)

---

## INFO-1 — Prompt-injection vector: NOT APPLICABLE

`towelieKnowledge.ts` runs a deterministic keyword overlap matcher (no LLM). Input is sanitized via `replace(/[^a-z0-9\s']/g, ' ')` before tokenizing, so no XSS or template-injection vector. Output is a static answer string. Confirmed via:
- No `openai`/`anthropic`/`gpt`/`claude` SDK imports anywhere in the Towelie path (`grep -i` cleared).
- Only consumer is `TowelieAssistant.tsx:272`, which renders the answer as text (no `dangerouslySetInnerHTML` was checked but unrelated to this file).

Recommend: Add a comment in `towelieKnowledge.ts` header confirming "no LLM, no remote call, no template eval — pure local matcher" so future maintainers don't add an LLM upgrade that introduces the exact vector hunters are checking for.

---

## INFO-2 — `tax rate` claim absent

The file does NOT make a TOWELI transfer-tax claim. On-chain `Toweli.sol:27` is plain ERC20 + Permit, no tax. Consistent. (Sometimes these files claim "no buy/sell tax" — Towelie does not, which is fine.)

## INFO-3 — Contract addresses not embedded in towelieKnowledge.ts

The file routes to `/contracts` and `/security` rather than embedding 0x addresses. Avoids the entire "contract address contradiction" attack surface — good design.

## INFO-4 — `safeBigintToNumber` and `clampPoints` are well-formed

Defensive against bigint overflow, NaN, infinity. Matches the file's stated "defense-in-depth" posture.

---

## Summary — Top 3

1. **MEDIUM-1**: "100% of swap fees to stakers" is on-chain false — actual split is 5/6 to LPs, 1/6 to protocol. Fix copy before any external launch / press.
2. **MEDIUM-2**: "Penalty scales with unlock distance" is on-chain false — flat 25% via `EARLY_WITHDRAWAL_PENALTY_BPS = 2500`. Users will be surprised at their first early-exit.
3. **MEDIUM-3**: "Stack JBAC NFTs for stacked boost" is on-chain false — `holdsJBAC ? 1.5 : 1`, no additive stacking. Could induce purchases on a false premise.

Notable absences: prompt-injection vector N/A (no LLM); points engine's deprecated client-side recorders properly neutered; pointsEngine.ts's authoritative-on-chain comment is sound.

Outstanding latent risk: `incrementReferralCount` is a replay-vulnerable function still exported (MEDIUM-5).
