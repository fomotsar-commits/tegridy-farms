# RC2 — Recovery: re-apply R035 static page drift fixes

R035 was reverted in the working tree. This pass re-applies every drift fix
identified in `R035.md` against the current state of the static pages, with no
artwork changes.

## Source of truth consulted
- `frontend/src/lib/constants.ts` — canonical Wave 0 addresses
- `TOKENOMICS.md` — supply split (45/30/10/10/5)
- `contracts/src/SwapFeeRouter.sol` — `feeBps = 50` (0.50%, dynamic, MAX 100)
- `git remote -v` — `fomotsar-commits/tegridy-farms`

## Changes applied

### `frontend/src/pages/SecurityPage.tsx`
- Imported `TEGRIDY_STAKING_ADDRESS`, `TEGRIDY_FACTORY_ADDRESS`,
  `TEGRIDY_ROUTER_ADDRESS`, `TEGRIDY_LENDING_ADDRESS`,
  `TEGRIDY_NFT_LENDING_ADDRESS`, `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` from
  `../lib/constants`.
- Replaced all six hex literals in `CONTRACTS` with the imports. `TegridyStaking`
  was the paused v1 (`0x65D8…0421`) — now resolves to canonical V2
  (`0x6266…4819`). `TegridyNFTLending` was pre-Wave-0 (`0x63baD…68aD`) — now
  resolves to the C-02 redeploy (`0x0540…B139`).
- Added `AUDIT R035` block comment documenting the drift removed.

### `frontend/src/pages/TermsPage.tsx`
- §7 fee text: `0.3% fee on all token swaps` → `0.50% fee on token swaps routed
  through the SwapFeeRouter (SWAP_FEE_BPS = 50; capped at 1.00% / MAX_FEE_BPS =
  100 by contract)`. Added "subject to the on-chain timelock" qualifier on the
  governance line.

### `frontend/src/pages/TokenomicsPage.tsx`
- Replaced 4-bucket `SUPPLY_DATA` (65 / 20 / 10 / 5) with the 5-bucket
  TOKENOMICS.md split: Circulating 45 / LP Seed 30 / Treasury 10 / Community 10
  / Team (vesting) 5. Distinct fills per slice (theme palette: amber, pink,
  purple, green, blue) so the legend is readable. Existing chart shell, layout,
  and copy preserved (per `feedback_preserve_art.md`).

### `frontend/src/pages/FAQPage.tsx`
- "What is the lock duration?" — `1 to 52 months` → `7 days up to 4 years`,
  named the contract constants (`MIN_LOCK_DURATION = 7 days`,
  `MAX_LOCK_DURATION = 4 years`).
- "What is a boost multiplier?" — `1x → 2.5x at 52 months` → `0.4x at 7 days
  → 4.0x at 4 years` linear, 4.5x ceiling with JBAC bonus
  (`MAX_BOOST_BPS_CEILING = 45000`).
- "What are NFT boosts?" — `JBAC, Nakamigos, or GNSS receive 10–20%` →
  `JBAC NFT receive a flat +0.5x bonus`. Removed the unsupported
  Nakamigos/GNSS claim. Capped reference retained.

### `frontend/src/pages/ContractsPage.tsx`
- `GITHUB_BASE` corrected from `tegridyfarms` org → `fomotsar-commits/tegridy-farms`.
  Added `AUDIT R035` comment.
- Tracked-issues link (L360 region) corrected from typo `tegriddy-farms`
  (double-d) → `tegridy-farms`. All per-contract source links and the wait-list
  badge now resolve.

### `frontend/src/pages/RisksPage.tsx`
- No changes. Already uses the correct `fomotsar-commits/tegridy-farms` org for
  `FIX_STATUS.md` and `AUDITS.md` links — verified via grep.

## Verification
- `npx tsc --noEmit` (frontend) — clean exit, zero errors.
- `grep tegriddy-farms frontend/src` — no remaining typos in source.
- `grep tegridyfarms/ frontend/src` — only the legitimate Immunefi URL
  (`immunefi.com/bug-bounty/tegridyfarms/`) remains; not a GitHub link.
- No artwork or page sections removed; corrections are textual / data-only.
- Addresses now flow from `constants.ts` so future Wave 0 redeploys propagate
  automatically.

## Files touched
- `frontend/src/pages/SecurityPage.tsx`
- `frontend/src/pages/TermsPage.tsx`
- `frontend/src/pages/TokenomicsPage.tsx`
- `frontend/src/pages/FAQPage.tsx`
- `frontend/src/pages/ContractsPage.tsx`

## Files read but not changed
- `frontend/src/lib/constants.ts`
- `frontend/src/pages/RisksPage.tsx`
- `.audit_101/remediation/R035.md`
