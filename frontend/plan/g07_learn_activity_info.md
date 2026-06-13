# Remediation Plan — g07 Learn / Activity / Info tab hosts + Admin

Surface: `LearnPage` (Tokenomics/Lore/Security/FAQ), `ActivityPage` (Leaderboard/History/Premium), `InfoPage` (Treasury/Contracts/Risks/Terms/Privacy) and `AdminPage`. Verified at HEAD of `mvp-launch` (`b6fda8b`).

All findings were confirmed against source. Headline result: the biggest cluster is **T4 fabricated/overstated trust claims** (Immunefi, "Verified on Etherscan", "controlled by team multisig", "3-of-5 pause guardian", wrong fee in Terms) and **T3 stale constants/copy** (Wave-0 vocabulary, stale changelog, stale audit stats, pre-relaunch CONTRACTS.md). One real **product-blocker latent bug**: the Gold Card UI advertises plan discounts the `PremiumAccess` contract never implements (F375). Several findings are already correct at HEAD and only need a prod redeploy (F425 FAQ-answer search, F442 treasury feed) — they are flagged accordingly.

Mandate respected throughout: **additive only** — no existing art or page section is removed; trust copy is corrected/softened, never deleted.

---

## Batch: trust-claims-honesty-pass

The single highest-impact batch. SecurityPage + FAQPage assert security posture (Immunefi partnership, "verified on Etherscan", "team multisig", "3-of-5 pause guardian") that the project's own RisksPage (June-11 honesty pass) already contradicts, and that on-chain reality does not back. Fix all the trust prose in one PR so the three pages flip together and never drift again. The canonical honest phrasing already exists in `RisksPage.tsx` — mirror it.

### F372 — "Verified on Etherscan" badge is false (live contracts not source-verified)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Drop the hardcoded `&#10003; Verified` badge in `SecurityPage.tsx:265` (it asserts verification that doesn't exist — deploy record shows source-verify was pending on an invalid key). Replace with an honest neutral state. Cheapest correct fix: remove the static badge text and keep only the Etherscan link so users verify for themselves; or render "Verification pending" until the operator verifies. Do NOT derive live unless cheap — a one-shot `getsourcecode` per address via `/api/etherscan` is possible but adds N calls; prefer the static honest copy now and let operator verification (see F447/F409) flip it. Also soften the ContractsPage header (see F374's batch sibling) — that's a separate string.
- **files:** `src/pages/SecurityPage.tsx:265`
- **effort:** S
- **risk:** low
- **test:** Manual: load /security, confirm no "Verified" claim renders next to any address; Etherscan link still resolves.
- **deps:** []

### F380 — Multisig / pause-guardian claims contradict RisksPage (single-EOA reality)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Align `SecurityPage.tsx:333` ("Protocol admin controlled by team multisig") and `FAQPage.tsx:59` ("emergency pauses held by a 3-of-5 pause guardian") to the RisksPage phrasing — "single-operator admin key today; multisig migration in progress" (`RisksPage.tsx:14-16`). Edit the two array strings; keep the timelock/2-step-ownership bullets (those are true). Reword the FAQ "Can the admin rug pull?" answer to drop the "3-of-5 pause guardian" claim.
- **files:** `src/pages/SecurityPage.tsx:333`, `src/pages/FAQPage.tsx:59`
- **effort:** S
- **risk:** low
- **test:** Manual: /security Multisig section and /faq rug-pull answer now match /risks single-key language.
- **deps:** []

### F381 — Immunefi partnership + bounty tiers likely overstated (code-agent hypothesis)
- **verdict:** duplicate
- **rootCause:** T4
- **approach:** Same defect as F415 (live agent curl-confirmed the Immunefi URL 404s). Resolve under F415; this code-side hypothesis is the same string at `SecurityPage.tsx:302-306`.
- **files:** `src/pages/SecurityPage.tsx:302-306`, `:40-45`
- **effort:** S
- **risk:** low
- **test:** See F415.
- **deps:** [F415]

### F415 — Immunefi bug-bounty program does not exist; "Submit on Immunefi" 404s (CRITICAL)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** A fake partnership claim on the trust page is the worst credibility hit. Two parts: (1) rewrite the prose at `SecurityPage.tsx:302` to drop "We partner with Immunefi, the leading Web3 bug bounty platform" → honest "Bug bounty paid case-by-case — report via Twitter DM @junglebayac or the disclosure channel in SECURITY.md"; (2) remove the `https://immunefi.com/bug-bounty/tegridyfarms/` link + "Submit on Immunefi" button at `:303-306`. Keep the `$10k/$5k/$1k/$500` tier cards ONLY if the operator commits to funding them — otherwise reframe as "indicative severity bands, paid as treasury allows" (treasury Safe is documented empty). **product-decision input needed** on whether to keep tier dollar amounts. The mascot tooltip (F432) and the Risks "no Immunefi" note already point the honest way.
- **files:** `src/pages/SecurityPage.tsx:302-306`, `:40-45`
- **effort:** S
- **risk:** low
- **test:** Manual: /security Bug Bounty section has no Immunefi link/partnership claim; any remaining external link resolves (curl 200).
- **deps:** []

### F432 — Mascot tooltip overstates security posture ("Audited and bug-bountied")
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Soften the mascot bubble copy on /security to "Internally red-teamed to hell and back" (keeps the joke, drops the false "audited and bug-bountied" claim that contradicts FAQ + the 404 bounty). Find the tip string in `TowelieAssistant.tsx` (mascot tip table keyed by route).
- **files:** `src/components/TowelieAssistant.tsx` (security-route tip string)
- **effort:** S
- **risk:** low
- **test:** Manual: trigger mascot on /security, confirm new copy.
- **deps:** []

### F391 — Hardcoded test-suite stats stale (~3x undercount)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `SecurityPage.tsx:139` says "38,794 lines of test code across 34 test files" but the repo has 95 `*.t.sol` files and the FAQ itself cites a "1,500+ test suite". Replace the rotting exact figure with an order-of-magnitude phrase that won't decay (e.g. "90+ Foundry test files, 1,500+ tests across the suite") — matches `FAQPage.tsx:58`.
- **files:** `src/pages/SecurityPage.tsx:139`
- **effort:** S
- **risk:** low
- **test:** Manual: numbers match the FAQ claim.
- **deps:** []

### F435 — Audit chip label dates drift from linked filenames
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `SecurityPage.tsx:183` labels "Pass-7 audit + remediation (May 4)" but links `PASS7_2026_05_03.md` (May 3). Make the visible date match the artifact filename date (change label to May 3, or rename — label edit is the minimal change).
- **files:** `src/pages/SecurityPage.tsx:183`
- **effort:** S
- **risk:** low
- **test:** Manual: label date == filename date for every audit chip.
- **deps:** []

### F386 — FAQ cites GOVERNANCE.md which doesn't exist
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `FAQPage.tsx:59` says "The full threat model is in GOVERNANCE.md and on the Risks page." No `GOVERNANCE.md` is tracked. Point to a doc that exists (`AUDITS.md` / `FIX_STATUS.md`, already linked from RisksPage) or drop the GOVERNANCE.md reference and keep "…and on the Risks page." Minimal: delete the dead filename.
- **files:** `src/pages/FAQPage.tsx:59`
- **effort:** S
- **risk:** low
- **test:** Manual: no dead doc reference in the answer.
- **deps:** []

### F424 — Multisig/timelock claims have no on-chain proof links / "as of" state (live)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** After F380 softens the copy, additively add Etherscan links for the Safe + (if/when one exists) the timelock next to the Multisig & Governance bullets, mirroring the contract-row link pattern already on the page, plus an "as of <date>" stamp. Until acceptOwnership lands keep the "transitioning to multisig control" phrasing from F380. Lands in the same PR as F380.
- **files:** `src/pages/SecurityPage.tsx:327-342`
- **effort:** S
- **risk:** low
- **test:** Manual: Safe link resolves to the on-chain owner; "as of" date present.
- **deps:** [F380]

---

## Batch: contracts-page-relaunch-truth

ContractsPage and TermsPage carry pre-relaunch (Wave-0) framing, a wrong fee, a 404 source link, and a "verified" overclaim. All are T3/T4 copy/data edits in two files.

### F373 — Terms states wrong protocol fee (0.30% vs actual 0.5%)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `TermsPage.tsx:32` §7 says "0.30% … SWAP_FEE_BPS = 30". Live value is `SWAP_FEE_BPS = 50` (constants.ts:108) and RisksPage says 0.5%. Update §7 to "0.5% (SWAP_FEE_BPS = 50; 1.00% / MAX_FEE_BPS = 100 cap)". Also refresh "Last updated: April 2026" → current, and soften "modified through DAO governance proposals" / §10 "Tegridy Farms DAO" since no DAO exists and admin is a single EOA (per Risks) — reword to "modified by the protocol admin subject to the on-chain timelock."
- **files:** `src/pages/TermsPage.tsx:32`, `:43-44`, `:108`
- **effort:** S
- **risk:** low
- **test:** Manual: /terms §7 reads 0.5%/50bps; date current; no DAO claim.
- **deps:** []

### F440 — Swap fee contradicts itself across Terms (0.30%) vs Risks (0.5%) (live)
- **verdict:** duplicate
- **rootCause:** T3
- **approach:** Same root as F373 — Terms is the wrong one (Risks 0.5% is correct, matches constants). Fixing F373 resolves this. Optionally render the fee from `SWAP_FEE_BPS` in `constants.ts` so the two pages can never disagree again.
- **files:** `src/pages/TermsPage.tsx:32`
- **effort:** S
- **risk:** low
- **test:** See F373.
- **deps:** [F373]

### F374 — Linked CONTRACTS.md lists pre-relaunch (dead) addresses as "Live"
- **verdict:** operator-action
- **rootCause:** T3
- **approach:** The page links repo `CONTRACTS.md` (`ContractsPage.tsx:313`) as its "source of truth", but that file (on both `main` and `mvp-launch`) lists superseded Wave-0 addresses. The doc must be regenerated from `constants.ts` (the page footer already promises this) and old addresses marked Deprecated — that's a repo/doc task, not frontend code. Frontend-side co-fix: point the link at `blob/mvp-launch` instead of `blob/main` (see F452) so even the current doc isn't served from a 234-commit-behind branch. The address rows on the page itself already flow from `constants.ts` and are correct.
- **files:** repo `CONTRACTS.md` (operator regen); `src/pages/ContractsPage.tsx:44` (`GITHUB_BASE` branch — shared with F452)
- **effort:** M
- **risk:** low
- **test:** After regen, the linked doc's addresses match `constants.ts`; deprecated ones labelled.
- **deps:** []

### F378 — Obsolete "Wave 0" framing + stale multisig 0x0c41…8bfe in legend/notes
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** Rewrite the "Wave 0 closure" legend (`ContractsPage.tsx:330-345`, incl. the stale `0x0c41…8bfe` multisig) and the per-row notes (`:88` LP Farming "Wave 0 redeploy live"; `:96` Fee Hook "redeploy queued") in relaunch terms — the relaunch superseded Wave 0, and LP Farming's owner is "pending the 0xA360 Safe" per `constants.ts:28`. Use the correct Safe address and current acceptOwnership status; retire "Wave 0" vocabulary. The `isDeployed()` badge gating itself is sound — keep it. Pull the canonical pending-state from the operator-tasks memo.
- **files:** `src/pages/ContractsPage.tsx:330-345`, `:84-97`, `:113-126`, `:137-162`
- **effort:** M
- **risk:** low
- **test:** Manual: /contracts legend + notes reference the relaunch Safe and current status; no "Wave 0" / `0x0c41…8bfe`.
- **deps:** []

### F372/F447 ContractsPage "All contracts are verified on Etherscan" header
- (Tracked under F447 below; the ContractsPage header string at `:311` is the contracts-page sibling of the SecurityPage badge.)

### F447 — "All contracts are verified on Etherscan" unconfirmable for the relaunch redeploys (live)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Soften the ContractsPage header at `ContractsPage.tsx:311` from "All contracts are verified on Etherscan." to "Source for every contract is linked below" (the GitHub per-row links already provide source) until the operator re-verifies on Etherscan after rotating the API key. This is the same overclaim as the SecurityPage badge (F372). After operator verification (F409/operator), the stronger claim can return.
- **files:** `src/pages/ContractsPage.tsx:311`
- **effort:** S
- **risk:** low
- **test:** Manual: /contracts header no longer asserts blanket verification.
- **deps:** []

### F387 — Treasury source link 404s (contracts/src/Treasury.sol doesn't exist)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `ContractsPage.tsx:73` renders Treasury with `source: 'contracts/src/Treasury.sol'` → a GitHub link that 404s; the treasury is a 2-of-2 Safe (`constants.ts:80`), not a contract. Change `source` to `'external (Safe multisig)'` so the row renders as non-link text (the `isExternal = source.startsWith('external')` branch at `:183` already handles this, like the JBAC/WETH rows).
- **files:** `src/pages/ContractsPage.tsx:73`
- **effort:** S
- **risk:** low
- **test:** Manual: Treasury row shows "external (Safe multisig)" with no broken GitHub link.
- **deps:** []

### F441 — Treasury "EOA/multisig" on Risks vs "deployed Treasury.sol" on Contracts (live)
- **verdict:** duplicate
- **rootCause:** T3
- **approach:** Same contradiction as F387 — the treasury is a Safe, so ContractsPage labelling it `Treasury.sol` is the stale side. Fixing F387 (mark it `external (Safe multisig)`) resolves the cross-page contradiction; RisksPage is already correct. (Note: the live agent's claim that /treasury links Treasury.sol as source is inaccurate — `TreasuryPage.tsx:323` links the Etherscan **address**, not a source file.)
- **files:** `src/pages/ContractsPage.tsx:73`
- **effort:** S
- **risk:** low
- **test:** See F387.
- **deps:** [F387]

### F452 — Doc links point at /blob/main while default branch is mvp-launch (live)
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `GITHUB_BASE` in `ContractsPage.tsx:44` and the RisksPage doc links (`RisksPage.tsx:302,311`) hardcode `/blob/main/…`; the repo default/deploy branch is `mvp-launch` (234 commits ahead). Point them at `/blob/mvp-launch/` (or a build-time-injected commit SHA). Single shared `GITHUB_BASE` const change on ContractsPage; update the two RisksPage hrefs. Also covers the SecurityPage audit-artifact links if you choose to make them consistent.
- **files:** `src/pages/ContractsPage.tsx:44`, `src/pages/RisksPage.tsx:302`, `:311`
- **effort:** S
- **risk:** low
- **test:** Manual: doc links open the mvp-launch version of each file (200, current content).
- **deps:** []

---

## Batch: changelog-relaunch-entry

### F379 — Changelog 5+ weeks stale, omits June-6 relaunch, contradicts Security
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** Prepend a "June 2026 — Mainnet Relaunch" entry to the `CHANGELOG` array (`ChangelogPage.tsx:17`): new deployer wallet, 14 contracts live via DeployMVP, list what was deferred (gauge/vote-incentives/grants/premium/lending/NFT pools/launchpad). Additionally annotate the April-14 "Deployed TegridyNFTLending / NFTPoolFactory" entries (`:86-87`) as "(superseded deployment — these contracts were NOT redeployed in the relaunch and are not live)" so they stop contradicting SecurityPage's "Not deployed — deferred from the relaunch" (`SecurityPage.tsx:260`). Pure data-array edit.
- **files:** `src/pages/ChangelogPage.tsx:17-29` (new entry), `:83-92` (annotate)
- **effort:** S
- **risk:** low
- **test:** Manual: /changelog top entry is the relaunch; no contradiction with /security contract list.
- **deps:** []

### F416 — Changelog stale + contradicts Security page (live)
- **verdict:** duplicate
- **rootCause:** T3
- **approach:** Same finding as F379 (live-confirmed). Resolved by F379.
- **files:** `src/pages/ChangelogPage.tsx:17`
- **effort:** S
- **risk:** low
- **test:** See F379.
- **deps:** [F379]

### F431 — Changelog entries are raw audit jargon with no reader summary (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additively add an optional `tldr` string field to `ChangelogEntry` and render a one-line "What this means for you:" chip above the technical bullets when present. Backfill `tldr` for the most-recent entries only. Keeps the transparency, adds comprehension. No bullet removed.
- **files:** `src/pages/ChangelogPage.tsx:6-10` (type), `:17-124` (data), `:184-202` (render)
- **effort:** M
- **risk:** low
- **test:** Manual: each entry with a tldr shows the plain-English chip.
- **deps:** []

### F408 / F436 — Changelog: no per-release anchors, no RSS/subscribe, hardcoded TSX array
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additive: (1) give each entry a stable `id` slug (date-based) and an anchor link icon so `#june-2026-relaunch` is shareable; (2) add a "follow updates on X/Telegram" chip at the top. RSS/atom generation and moving entries to a data/markdown file are larger and can stay backlog (note in PR). F436 is the live duplicate of F408's anchor+subscribe half.
- **files:** `src/pages/ChangelogPage.tsx:6-10`, `:154-205`
- **effort:** M
- **risk:** low
- **test:** Manual: clicking an entry anchor updates the URL hash; follow chip links resolve.
- **deps:** [F397]

---

## Batch: admin-refetch-and-gating

AdminPage write-after-refetch, the un-gated PremiumAccess (zero-address) reads, and polish fixes — all in one file.

### F376 — Premium Access card reads the zero address (perpetual "…" + 0x0 Etherscan link)
- **verdict:** fix-now
- **rootCause:** T7 (gate the action/section, not surface a dead 0x0)
- **approach:** Gate the three PremiumAccess reads (`AdminPage.tsx:198-200`) and the "Premium Access" `ContractCard` (`:382-387`) on `isDeployed(PREMIUM_ACCESS_ADDRESS)`. When undeployed, render a "pending deploy" card state (mirror ContractsPage's pending row) instead of "…" forever and an Etherscan link to `0x0000…`. `usePremiumAccess.ts:52` already has exactly this gate — copy the pattern. Note: reads only fire for the owner (`enabled: isOwner`), so blast radius is the operator, but the dead 0x0 link is still wrong.
- **files:** `src/pages/AdminPage.tsx:197-200`, `:382-387`
- **effort:** S
- **risk:** low
- **test:** Manual (as owner): Premium Access card shows "pending deploy", no 0x0 Etherscan link.
- **deps:** []

### F384 — Pause/unpause success never refetches read batch; write errors silent
- **verdict:** fix-now
- **rootCause:** T5
- **approach:** Two parts in `PauseControls` (`AdminPage.tsx:76-146`): (1) thread the `useReadContracts` `refetch` (from the parent batch at `:188`) into the success effect (`:90-95`) so the ACTIVE/PAUSED pill + Status row re-read after a pause tx confirms, instead of waiting on a window-focus refetch; (2) destructure `error` from `useWriteContract` and surface it via `toast.error` (compare `usePremiumAccess.ts:154-171` which toasts every error path) so a wallet rejection / gas-estimate failure isn't silent. Pass `refetchReads` down alongside the existing `refetchOwner` prop.
- **files:** `src/pages/AdminPage.tsx:76-110`, `:188-210`, `:404`
- **effort:** S
- **risk:** med (touches the destructive pause write path — verify the toast/refetch don't change the confirm gate behaviour)
- **test:** Manual (as owner on a fork): pause → pill flips to PAUSED without focus change; reject in wallet → error toast appears. Optionally a unit test mocking `useWriteContract` error.
- **deps:** []

### F401 — Pending Fee renders "0 bps" instead of "None"; stale 30s-vs-10s comment
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `AdminPage.tsx:233` uses `pendingFee != null ? ... : 'None'` so a real read of `0` (cleared timelock) shows "0 bps" where "None" is meant — treat `0` as "None" (`pendingFee != null && Number(pendingFee) > 0 ? ... : 'None'`). Fix the stale comment at `:346` ("30s refetch") to match `refetchInterval: 10_000` at `:171`.
- **files:** `src/pages/AdminPage.tsx:233`, `:346`
- **effort:** S
- **risk:** low
- **test:** Manual: with a zero pendingFeeBps read, row shows "None".
- **deps:** []

### F462 — Admin gate card has no inline connect action (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Add a Connect Wallet button inside the not-connected gate card (`AdminPage.tsx:272-275`), mirroring the `ConnectButton.Custom` pattern used in `/farm` and `HistoryPage.tsx:367-373`. Additive; gate logic unchanged.
- **files:** `src/pages/AdminPage.tsx:272-275`
- **effort:** S
- **risk:** low
- **test:** Manual: logged-out /admin shows a working Connect button in the card.
- **deps:** []

### F412 — Admin: no timelock queue viewer / admin-events log / multi-contract pause
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Best-in-class gap. The page literally says "Pending timelock operations are managed via direct contract interaction" (`AdminPage.tsx:70`) and pause covers only TegridyStaking. A timelock-queue viewer + recent-admin-events log + multi-contract pause panel is a meaningful build (needs event indexing + per-contract pause ABIs). Defer to an owner decision on scope before coding; it's operator-only UI so user-facing priority is low.
- **files:** `src/pages/AdminPage.tsx` (new sections)
- **effort:** L
- **risk:** med
- **test:** N/A until scoped.
- **deps:** []

---

## Batch: explorer-chainid-pinning

### F390 — Explorer links derived from wallet chainId while data is always mainnet
- **verdict:** fix-now
- **rootCause:** T9
- **approach:** `HistoryPage.tsx:171` and `PremiumPage` `TxLink` (`:40`) feed `useChainId()` (the wallet's current chain) into `getTxUrl`/`getAddressUrl`, but the tx data comes from the mainnet-only `/api/etherscan` proxy — a wallet on Base/Arbitrum yields dead basescan/arbiscan links. Pass `CHAIN_ID` (constants) instead of `useChainId()` for these explorer URLs. `AdminPage` already solved this with the canonical-chain pattern (`:181-185`). One-line swap in each of the two call sites (and drop the now-unused `useChainId` import where applicable). Note: TreasuryPage's `chainId` is also wallet-derived but its reads are mainnet too — pin it there as well for consistency (low-risk, same fix).
- **files:** `src/pages/HistoryPage.tsx:171` (+ usages `:425,:474,:481,:499`), `src/pages/PremiumPage.tsx:40-43`, optionally `src/pages/TreasuryPage.tsx:84`
- **effort:** S
- **risk:** low
- **test:** Manual: switch wallet to Base, open /history → row links go to etherscan.io, not basescan.
- **deps:** []

---

## Batch: history-feed-completeness

### F382 — History filter omits live contracts (LP Farming, native Router/LP) while footer claims full coverage
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** Add `LP_FARMING_ADDRESS`, `TEGRIDY_ROUTER_ADDRESS`, `TEGRIDY_LP_ADDRESS` (and the staking/SFR admin sisters if desired) to the fetch contract list (`HistoryPage.tsx:202-206`) AND to `categorizeTx` so LP-farm stakes/claims and native-router liquidity adds appear and get labelled — otherwise the footer "all Tegridy Farms protocol contracts" (`:559`) is false. Best done **after** F383 (DRY) so the contract list + categorize live in one place (`lib/txHistory.ts`), then both HistoryPage and the Treasury feed gain coverage in one edit. If F383 doesn't land first, edit both the page's inline copy and the lib.
- **files:** `src/lib/txHistory.ts:9-14,:78-160` (preferred single source), `src/pages/HistoryPage.tsx:202-206,:98-166`
- **effort:** M
- **risk:** low
- **test:** Manual with a wallet that staked LP: LP-farm tx now shows as "Farm/Stake"; unit test extending any `categorizeTx` test with an LP_FARMING `to`.
- **deps:** [F383]

### F383 — ~140 lines duplicated from lib/txHistory.ts, already diverging
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Finish the extraction the lib header already claims: import `TxRecordSchema`, `parseTxRecords`, `formatGasEth`, `categorizeTx` from `lib/txHistory.ts` into `HistoryPage.tsx` and delete the inline copies (`:22-166`). The lib version already has the optional `from` field (`txHistory.ts:26`) the page copy lacks — importing closes the divergence. Verify the page doesn't rely on any subtle difference before deleting. Pairs naturally with F382 (expand the contract list once, in the lib).
- **files:** `src/pages/HistoryPage.tsx:22-166`, `src/lib/txHistory.ts`
- **effort:** M
- **risk:** med (shared parser powers both History and Treasury feeds — regression here hits two surfaces; cover with the existing txHistory tests)
- **test:** Run existing `lib/txHistory` tests; manual /history + /treasury feed smoke test.
- **deps:** []

### F394 — No manual refresh while 5-min cache fresh; retry AbortController leak
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Two small fixes in `HistoryPage.tsx`: (1) add a refresh icon next to "Export CSV" (`:393-398`) that calls `fetchHistory(address, signal, true)` (skipCache) so a user who just transacted can force a refetch instead of seeing ≤5-min stale cache (`:180-197`); (2) tie `handleRetry`'s `AbortController` (`:282-288`) to component lifecycle (store in a ref / abort on unmount) so it doesn't leak.
- **files:** `src/pages/HistoryPage.tsx:282-288`, `:393-400`
- **effort:** S
- **risk:** low
- **test:** Manual: click refresh → network shows a fresh `/api/etherscan` call bypassing cache.
- **deps:** []

### F423 — Logged-out History is a pure connect-gate, no preview (live)
- **verdict:** product-decision
- **rootCause:** T7
- **approach:** Additively render a protocol-wide recent-activity feed (stakes/swaps/claims via the same `/api/etherscan` path against the protocol contracts, or the indexer when live) below the connect CTA, plus a faded sample-row preview of personal history. Gate only the personal data, not the page. Scope/feasibility depends on whether a protocol-wide query is acceptable cost-wise (T8 risk) — owner decision on whether to ship the public feed now vs wait for the indexer.
- **files:** `src/pages/HistoryPage.tsx:357-378`
- **effort:** M
- **risk:** med (adds always-on fetch on a public page — mind the rate-limiter, see T8)
- **test:** Manual: logged-out /history shows recent protocol activity + sample preview.
- **deps:** []

### F407 / F457 — History & Treasury: missing filters / token-transfer view / USD column / history charts
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Best-in-class gaps: History lacks type/status filter chips, date-range, ERC-20 transfer view, USD column, pending-tx surfacing (F407); Treasury lacks fees/TVL/distribution history charts (F457). All additive but multi-day and several need the indexer. Bundle as a backlog "activity-feed v2" decision; pick the cheapest wins (filter chips on already-fetched rows is S/M, no indexer needed) if the owner wants a partial.
- **files:** `src/pages/HistoryPage.tsx`, `src/pages/TreasuryPage.tsx`
- **effort:** L
- **risk:** low
- **test:** N/A until scoped.
- **deps:** []

---

## Batch: leaderboard-honesty-and-readability

### F377 — Advertised points mechanics are dead code (streak, daily visit, claim points)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** `pointsEngine.ts:190-197` makes `recordAction`/`recordDailyVisit` deprecated no-ops; nothing calls `recordDailyVisit`; `computeOnChainPoints` (`:136-156`) has no claim/visit component. So "Claim Rewards +15" and "Daily Visit +5" (`LeaderboardPage.tsx:174-175`) never accrue, Streak renders permanently "0d 🔥" (`:86`), Multiplier permanently "1x" (`:90`), and the `streak_7`/`streak_30` badges can never be earned. **Minimal honest fix:** remove the Claim/Daily-Visit rows from the "How Points Work" grid (`:170-184`) and the streak/multiplier stat tiles (`:84-91`) + the streak-multiplier line (`:185`) and the "streak computed locally" banner clause (`:42`); and document the REAL formula that IS computed (swap +10, stake +25 with +2/day of lock up to 1460d, LP +50 +up-to-200 from balance, referral +5). Do not invent a visit recorder (it can't be verified on-chain — that's why it was deprecated). Keep all art/sections.
- **files:** `src/pages/LeaderboardPage.tsx:42`, `:84-91`, `:170-185`
- **effort:** M
- **risk:** low
- **test:** Manual: no earn-action listed that awards 0; streak tile removed or relabelled; formula text matches `computeOnChainPoints`.
- **deps:** []

### F419 — Empty state asserts "No participants yet" as fact while data source isn't live (live)
- **verdict:** fix-now
- **rootCause:** T11 (loading-vs-empty conflation — renders an unverifiable zero)
- **approach:** `LeaderboardPage.tsx:154` shows "No participants yet. Stake TOWELI to earn your first points!" but the same page says cross-wallet data awaits the Ponder indexer and there are live on-chain stakers. Change to the honest "Ranking goes live once the indexer is public — be early: stake now to start your streak." Don't render an unverifiable zero. (This is the not-connected empty card.)
- **files:** `src/pages/LeaderboardPage.tsx:154`
- **effort:** S
- **risk:** low
- **test:** Manual: logged-out /leaderboard copy no longer claims emptiness as fact.
- **deps:** []

### F420 — Day mode renders "Your Tegridy Score" heading dark-on-dark (live)
- **verdict:** fix-now
- **rootCause:** T10 (contrast/theme)
- **approach:** In light/day mode the page body stays near-black (art panels) but the H1 (`LeaderboardPage.tsx:46`, `text-white`) flips to a dark token, becoming invisible. Audit the day-mode theme tokens for the Activity host: headings over the dark art panels must keep a light-on-dark pair. Cheapest: pin the heading to an explicit light color (it already sits over dark art) rather than letting the theme flip it, OR scrim the heading. Check `index.css` day-mode `--color` overrides that affect `text-white`/heading classes on these pages.
- **files:** `src/pages/LeaderboardPage.tsx:46`, `src/index.css` (day-mode tokens)
- **effort:** M
- **risk:** med (theme-token change can ripple to other pages — verify across Activity host)
- **test:** Manual: toggle day mode on /leaderboard, H1 readable.
- **deps:** []

### F421 — "All Badges" grid unreadable: dim locked text over bright art (live)
- **verdict:** fix-now
- **rootCause:** T10 (contrast)
- **approach:** The All Badges card (`LeaderboardPage.tsx:210-234`) double-dims locked badges (`opacity-30` at `:221`) over bright character art, making titles/descriptions illegible. Additive fix: raise the card scrim opacity / add `backdrop-blur` behind the badge grid (keep the art behind it), and represent the locked state with a lock icon instead of further text dimming (drop `opacity-30` on the text, keep it as a desaturate/lock affordance). Same treatment helps the "Your Stats" and "How Points Work" cards.
- **files:** `src/pages/LeaderboardPage.tsx:210-234`
- **effort:** S
- **risk:** low
- **test:** Manual: badge titles/descriptions legible in both earned and locked states.
- **deps:** []

### F418 — Page named "leaderboard" has no leaderboard / my-rank affordance (live)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Additive: show a "Top stakers (on-chain)" preview readable directly via RPC (staking contract balances/events) so the page has at least one real ranked list before the indexer, plus a disabled "Your rank — connect wallet" row. Real value but needs a bounded on-chain query (avoid an unbounded getLogs — see F392's lesson). Owner decision on whether to ship the RPC-only top-N now vs wait for the Ponder indexer (the banner already promises the indexer path).
- **files:** `src/pages/LeaderboardPage.tsx` (new section), new hook
- **effort:** L
- **risk:** med (on-chain ranking query cost/RPC limits — see T8/F392)
- **test:** N/A until scoped.
- **deps:** [F392]

### F406 — Leaderboard: no multi-user ranking (best-in-class)
- **verdict:** duplicate
- **rootCause:** standalone
- **approach:** Same gap as F418 (the missing ranked list), honestly gated on the indexer. Resolve together with F418's decision.
- **files:** `src/pages/LeaderboardPage.tsx`
- **effort:** L
- **risk:** med
- **test:** See F418.
- **deps:** [F418]

### F392 — Swap-count getLogs scan likely fails silently on public RPCs (4.7M-block range)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `usePoints.ts:73-84` calls `getLogs({ fromBlock: 18000000n, toBlock: 'latest' })` — a ~4.7M-block range that most public RPCs reject (commonly 10k cap), and the `.catch()` maps any failure to `swapCount 0`, so swap points + First-Swap/Degen badges silently never fire. The hardcoded `18000000` also predates the June-2026 SwapFeeRouter deploy. Fix: start `fromBlock` at the SwapFeeRouter deploy block (add a `SWAP_FEE_ROUTER_DEPLOY_BLOCK` const) and chunk the range (e.g. 10k-block windows) — or, better, read a per-user swap counter from the contract/indexer if available. Chunking is the minimal robust fix.
- **files:** `src/hooks/usePoints.ts:67-85`, `src/lib/constants.ts` (new deploy-block const)
- **effort:** M
- **risk:** med (RPC-dependent; verify chunked queries don't blow the rate limiter — see T8)
- **test:** Manual against a capped public RPC: swapCount > 0 for a wallet with swaps; First Swap badge lights.
- **deps:** []

---

## Batch: premium-page-discount-and-claims

### F375 — UI advertises -10/-20/-30% plan discounts the contract does not implement (latent mispricing)
- **verdict:** fix-now
- **rootCause:** T3 (UI math drifts from on-chain truth)
- **approach:** **Confirmed against the contract:** `PremiumAccess.sol` `subscribe` charges `uint256 cost = monthlyFeeToweli * months;` with NO discount, and `usePremiumAccess.ts` passes `maxCost` = full undiscounted cost. The UI (`PremiumPage.tsx:14-19` PLANS, `:63-66`/`:253-258` discounted totals, `:365` discounted approve label, `:67` `canAfford` against discounted figure) shows e.g. a 30%-off "1 Year" total but the wallet approval/charge is full — and `canAfford` can pass then revert on transferFrom. Currently unreachable (`PREMIUM_ACCESS_ADDRESS` zeroed → `FeatureNotDeployed` at `:78`) but goes live the day the address is restored. **Minimal safe fix now:** set all `discount: 0` in PLANS so displayed total = `monthlyFee × months` exactly and the struck-through price / `-%` badge disappear; remove the `100 - discount` math. If discounts are a real product goal, that's a **contract change before redeploy** (operator/product) — flag it. Do NOT ship discounted UI against a non-discounting contract.
- **files:** `src/pages/PremiumPage.tsx:14-19`, `:63-66`, `:253-258`
- **effort:** S
- **risk:** low (page is gated off today)
- **test:** Restore the address locally → plan totals equal `monthlyFee × months`; approval label matches charge; no struck-through price.
- **deps:** []

### F396 — No renew/extend path for active subscribers; shared tx state across the two claim buttons
- **verdict:** fix-now
- **rootCause:** T5 (shared write state)
- **approach:** Two parts: (1) `PremiumPage.tsx:245` hides the whole subscribe section when `premium.hasPremium`, but `PremiumAccess.sol` supports extensions (the `TOO_SOON_TO_EXTEND` branch, confirmed at contract ~line 266) — show an "Extend" variant of the plan picker for active monthly (non-lifetime) subscribers. (2) Both "Claim ETH" (`:413`) and "Claim Referral ETH" (`:438`) share `revenue.isPending/hash/isSuccess` from `useRevenueStats`'s single `useWriteContract`, so clicking one disables both and the success `TxLink` renders under both cards — track the two claim writes separately (two `useWriteContract` instances, or a `pendingAction` discriminator) in `useRevenueStats`. Part (2) is the higher-value bug; both gated off until PremiumAccess redeploys, so low urgency.
- **files:** `src/pages/PremiumPage.tsx:245-382`, `:411-451`, `src/hooks/useRevenueStats.ts`
- **effort:** M
- **risk:** low (gated off today)
- **test:** Restore address locally: active subscriber sees Extend; claiming one revenue stream doesn't disable the other or mis-render the TxLink.
- **deps:** []

### F422 — Gold Card page has zero value proposition — 3-line SOON banner (live)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** The page renders only the `FeatureNotDeployed` stub (`PremiumPage.tsx:78-94`) because `PREMIUM_ACCESS_ADDRESS` is zeroed. Additively enrich the stub (or the gated state) with: perks preview cards (the `ACTIVE_BENEFITS` array `:21-29` already exists — render it read-only), a "JBAC holders get free access" callout, links to the two FAQ premium answers, and a notify-me / follow-X CTA — so the page captures demand instead of dead-ending. Needs an owner call on how much to build for a not-yet-deployed feature; the benefit data already exists so it's cheap-to-medium.
- **files:** `src/pages/PremiumPage.tsx:78-94`, `src/components/ui/FeatureNotDeployed.tsx`
- **effort:** M
- **risk:** low
- **test:** Manual: /premium shows perks/JBAC/FAQ links/notify CTA over the existing ape-eye art (art preserved).
- **deps:** []

---

## Batch: faq-search-and-a11y

### F385 — Accordion open-state keyed by filtered indices — search transfers "open" to a different question
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `FAQPage.tsx:180` builds `key = ${sIdx}-${qIdx}` from indices into the **filtered** arrays, so opening "0-1" then typing a search that reshapes the filtered set leaves a different question expanded under the same key. Key the open state by a stable id — the question text (`item.q`) or a precomputed `section.category + '|' + item.q` — instead of positional indices. Update `toggle`/`openIndex` and the `panelId`/`buttonId` derivation to use the stable key.
- **files:** `src/pages/FAQPage.tsx:179-184`, `:96`
- **effort:** S
- **risk:** low
- **test:** Manual: open a question, type a filtering search → the originally-opened question (if still present) stays open; no unrelated question auto-expands. Add a small render test if convenient.
- **deps:** []

### F398 — Search input lacks an accessible name
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** Add `aria-label="Search questions"` to the FAQ search `<input>` (`FAQPage.tsx:142-148`) — it currently has only a placeholder, which is not an accessible name. One-attribute fix; the clear button already has an aria-label.
- **files:** `src/pages/FAQPage.tsx:142-148`
- **effort:** S
- **risk:** low
- **test:** axe/manual: input has an accessible name.
- **deps:** []

### F425 — FAQ search "matches titles only" (live)
- **verdict:** false-positive
- **rootCause:** T1
- **approach:** At HEAD the filter already indexes answer bodies — `FAQPage.tsx:102-103` does `item.q.toLowerCase().includes(...) || item.a.toLowerCase().includes(...)`. Typing "uniswap" WILL match the "How do I get TOWELI tokens?" answer. The live agent saw the **stale prod build**; this is fixed at HEAD. **redeploy-only** to surface it in prod. (The optional "highlight the matched term" enhancement is a separate nice-to-have, not a bug.)
- **files:** `src/pages/FAQPage.tsx:98-105`
- **effort:** S
- **risk:** low
- **test:** On HEAD/dev: type "uniswap" → the TOWELI answer matches. Confirms it's a prod-staleness artifact.
- **deps:** []

### F426 — "No questions match your search" empty state nearly invisible (live)
- **verdict:** fix-now
- **rootCause:** T11
- **approach:** The no-results message (`FAQPage.tsx:158-162`) renders as small dim text directly over bright art. Wrap it in the same dark panel style as the accordion containers (`background: rgba(13,21,48,0.85); border: 1px solid var(--color-purple-12)`) and add a "Clear search" button (reuse the `setSearch('')` handler from `:150`). Additive.
- **files:** `src/pages/FAQPage.tsx:158-162`
- **effort:** S
- **risk:** low
- **test:** Manual: search "zzzqqq" → readable panel + working Clear button.
- **deps:** []

### F434 — FAQ category labels low-contrast over bright art (live)
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** The section labels ("GETTING STARTED", "REWARDS", …) at `FAQPage.tsx:172-174` are small dark-purple caps directly on bright watercolor art. Give them the same translucent dark chip treatment as the accordion rows (a small `bg-[rgba(13,21,48,0.85)]` pill with padding) so they're legible over any art patch.
- **files:** `src/pages/FAQPage.tsx:172-174`
- **effort:** S
- **risk:** low
- **test:** Manual: category headers readable over the bright sections.
- **deps:** []

### F413 — FAQ: no per-question anchors / related links / feedback / contact CTA (best-in-class)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additive: give each question a stable `id` (derived from the same stable key as F385) and an anchor link for sharing, and add a contact CTA at the bottom of a failed search (pairs with F426's empty state). "Was this helpful" feedback + related-question links are larger and can stay backlog. Do the anchors+contact-CTA now (cheap, shares the stable-key work with F385).
- **files:** `src/pages/FAQPage.tsx:179-231`, `:158-162`
- **effort:** M
- **risk:** low
- **test:** Manual: `#question-slug` scrolls to and expands the target question.
- **deps:** [F385, F397]

---

## Batch: tokenomics-data-truth

### F388 — POLAccumulator flagged live:false although deployed in the relaunch
- **verdict:** fix-now
- **rootCause:** T3
- **approach:** `TokenomicsPage.tsx:44` sets `{ label: 'POLAccumulator', …, live: false }`, but `POL_ACCUMULATOR_ADDRESS` is deployed (`constants.ts:23`, RELAUNCH 2026-06-06), so the badge logic (`:233-239`) renders amber "Deployed" instead of green "Live". Flip `live: true` — or, cleaner, drop the redundant `live` flag entirely and rely solely on `isDeployed()` (the other rows that are zeroed will still fall to "Pending" via the `isDeployed` short-circuit at `:235`). Removing the flag also pre-empts F428.
- **files:** `src/pages/TokenomicsPage.tsx:35-45`, `:233-239`
- **effort:** S
- **risk:** low
- **test:** Manual: POLAccumulator row shows green "Live".
- **deps:** []

### F428 — "Live" vs "Deployed" badge taxonomy unexplained (live)
- **verdict:** duplicate
- **rootCause:** T3
- **approach:** The orange "Deployed" badge only appears because of the F388 `live:false` mislabel. Removing the `live` flag (F388) collapses to Live/Pending and eliminates the unexplained third term. If a third state is ever genuinely needed, add a tooltip; for now F388 resolves it.
- **files:** `src/pages/TokenomicsPage.tsx:44`
- **effort:** S
- **risk:** low
- **test:** See F388.
- **deps:** [F388]

### F399 — FDV counts burned supply; pie "Circulating 45%" is policy not measured
- **verdict:** fix-now
- **rootCause:** T6 (raw/unadjusted value) / standalone
- **approach:** `TokenomicsPage.tsx:80` computes FDV as `TOWELI_TOTAL_SUPPLY × price` while ~25.8% of supply is burned, overstating FDV ~35%. Additively add a "Burned" stat and a burn-adjusted market cap next to FDV — the dead-address balance is a single `balanceOf(0x…dead)` read (and 25.8% burn is a marketing asset the page currently hides). Keep FDV (it's a standard metric) but label it FDV and show circulating/burn-adjusted alongside. The `SUPPLY_DATA` pie is launch-policy — annotate it as such rather than implying measured circulating.
- **files:** `src/pages/TokenomicsPage.tsx:74-104`, `:27-33`, new burn read (reuse a balanceOf hook)
- **effort:** M
- **risk:** low
- **test:** Manual: Burned stat shows ~25.8%; burn-adjusted mcap renders; FDV unchanged but clearly labelled.
- **deps:** []

### F427 — Emission numbers disagree on the page + round away 6% of the seed (live)
- **verdict:** redeploy-only
- **rootCause:** T1 / T3
- **approach:** At HEAD the two day-counts both derive from the same `daysLeft` (`TokenomicsPage.tsx:160` and `:211`) and "Rewards Remaining" now ticks down off `periodFinish` (`:59,:203`) — the June-11 honesty pass already fixed the "remaining == funded / never decays" defect the live agent saw. So the "89 vs 90" / "6M vs 6.4M (no decay)" report is largely the **stale prod build**; ship HEAD. Optional small polish (own batch): display "6.4M" by using 1-decimal compact formatting for the seed figures via the shared `formatNumber` (currently `formatNumber(x, 0)` truncates 410k) — a 1-line precision tweak, not a bug.
- **files:** `src/pages/TokenomicsPage.tsx:54-60`, `:156-160`, `:201-211`
- **effort:** S
- **risk:** low
- **test:** On HEAD: confirm both day figures equal and Rewards Remaining < Funded and decreasing.
- **deps:** []

### F437 — No time-axis emission chart (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Additive: add a small area chart "emissions remaining over time" (the page already imports recharts and has the donut for layout reference) marking the period-end, computed from `rewardRate × secondsRemaining`. Pre-answers the September emission-cliff question. Reuse the existing `Sparkline`/recharts setup.
- **files:** `src/pages/TokenomicsPage.tsx:146-175` (Emissions card)
- **effort:** M
- **risk:** low
- **test:** Manual: chart renders a downward runway to the end date.
- **deps:** []

### F405 — Tokenomics: missing circulating/mcap, burned stat, holders, watchAsset, emissions chart, CG/DEXTools links (best-in-class)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Umbrella of additive table-stakes items. The high-value, low-cost ones overlap existing findings: burned-supply + burn-adjusted mcap (F399), emissions chart (F437), and an "Add TOWELI to wallet" button (`wallet_watchAsset` — a few lines). Holders count needs an indexer/explorer call; CoinGecko/DEXTools links are trivial additions next to the existing GeckoTerminal link (`:259`). Land the cheap ones (watchAsset button + extra market links) in the tokenomics-data batch; defer holders to indexer.
- **files:** `src/pages/TokenomicsPage.tsx:74-104`, `:254-268`
- **effort:** M
- **risk:** low
- **test:** Manual: watchAsset adds TOWELI to MetaMask; CG/DEXTools links resolve.
- **deps:** [F399, F437]

---

## Batch: lore-dom-and-padding

### F389 — Invalid DOM nesting (div inside ol) + asymmetric padding from inline paddingLeft:0
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** `LorePage.tsx:66` `<ol … px-4 md:px-6 … list-none m-0 p-0" style={{ paddingLeft: 0 }}>` — the inline `paddingLeft: 0` overrides `px-4`'s left padding, so cards hug the left edge on mobile while keeping right padding. Drop the inline `paddingLeft` (the `list-none` + `px-4` already handle it). And `:90` places the CTA `<m.div>` as a direct child of the `<ol>` — invalid HTML (only `li`/`script`/`template` allowed). Wrap the CTA in an `<li>` (or move it after the `</ol>`). Two minimal edits; no content/art change.
- **files:** `src/pages/LorePage.tsx:66`, `:90-95`
- **effort:** S
- **risk:** low
- **test:** Manual: symmetric padding on mobile; React/DOM no longer warns about invalid `<ol>` nesting (check console).
- **deps:** []

---

## Batch: privacy-anchors-and-links

### F397 — Section anchor deep-links declared but don't scroll
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `PrivacyPage.tsx` declares stable `id`s + `scroll-mt-24` (`:89,:93`) for deep-linking, but `App.tsx`'s `ScrollToTop` (`:109-113`) does `window.scrollTo(0,0)` on every pathname change and ignores `location.hash`, and the native `#hash` scroll fires before the lazy/animated content mounts. Fix in `ScrollToTop`: when `location.hash` is present, `document.getElementById(hash)?.scrollIntoView()` after mount (a `requestAnimationFrame` / short timeout to let Suspense + entrance settle) instead of scrolling to top. This unlocks anchor deep-linking site-wide (also enables F408/F413 anchors).
- **files:** `src/App.tsx:108-113`
- **effort:** S
- **risk:** med (touches global scroll behaviour on every route change — verify normal navigations still scroll to top)
- **test:** Manual: load `/privacy#data-storage` → scrolls to the Data Storage section, not the top.
- **deps:** []

### F460 — Repo file paths cited inline in legal text without links; stray "Basescan" (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Hyperlink the inline repo references in PrivacyPage body strings to GitHub (`frontend/src/lib/errorReporting.ts` `:20`, `docs/SECRET_ROTATION.md` `:40`, `frontend/src/pages/PrivacyPage.tsx` `:50`) — the transparency is good, make it one click. Drop or justify the "Basescan" mention at `:25` (app is Ethereum-mainnet only). Because the body is a plain string, either split the strings to inject `<a>` or move those refs into a small links list under each section. Use the `blob/mvp-launch` base (F452) for the GitHub hrefs.
- **files:** `src/pages/PrivacyPage.tsx:20`, `:25`, `:40`, `:50`
- **effort:** M
- **risk:** low
- **test:** Manual: file references render as resolving GitHub links; no Basescan reference.
- **deps:** [F452]

---

## Batch: treasury-zero-vs-dash

### F451 — Stat cards mix em-dash and zero for the same meaning (live)
- **verdict:** fix-now
- **rootCause:** T6 (raw/ambiguous value rendering — dash conflated with "failed to load")
- **approach:** In `TreasuryPage.tsx`, `formatUsd` (`:48-53`) and `formatEth` (`:55-60`) return "–" for `0`, while siblings show explicit zeros — so a successful read of zero renders inconsistently ("Lifetime Fees –" with "0.0000 ETH routed" subtitle; "Treasury Balance 0 ETH" with "–" subtitle). Show explicit zeros ("$0.00", "0 ETH") when the read **succeeded**, and reserve "–" for actual read failures (the values are `undefined` until the read resolves — distinguish `undefined` → "–"/skeleton vs `0` → "$0.00"). Adjust the two formatters and the `stats` mapping (`:173-178`) to pass through a "no data yet" sentinel.
- **files:** `src/pages/TreasuryPage.tsx:48-60`, `:160-178`
- **effort:** S
- **risk:** low
- **test:** Manual: with on-chain zeros, both headline and subtitle show "$0.00"/"0 ETH" consistently; only a failed/pending read shows "–".
- **deps:** []

### F442 — "Recent Treasury Transactions" permanently "momentarily unavailable" (live)
- **verdict:** operator-action
- **rootCause:** T1 / standalone
- **approach:** **Code is correct at HEAD** — `RecentTreasuryTransactions` DOES attempt `fetchAddressTxList(...)` against `/api/etherscan` (`TreasuryPage.tsx:350-352`); the error string only renders when **both** proxy calls fail (`:359-362`), which happens in prod because the Etherscan API key was invalid at deploy (the documented stale-key issue). So the real fix is **operator: rotate the Etherscan key + redeploy** (the live agent's "no /api/ call is attempted" was the stale prod build). Tiny optional code co-fix: soften the copy from "momentarily unavailable" to "view full ledger on Etherscan ↗" so a persistent outage doesn't read as a transient one (`:360`).
- **files:** operator (Etherscan key rotation + prod redeploy); optional `src/pages/TreasuryPage.tsx:360`
- **effort:** S
- **risk:** low
- **test:** After key rotation + deploy: /treasury feed renders real IN/OUT rows.
- **deps:** []

### F404 — useBlockNumber({watch:true}) keeps a per-block subscription for one caption
- **verdict:** fix-now
- **rootCause:** T8 (always-on poller)
- **approach:** `TreasuryPage.tsx:89` watches every mainnet block (~12s) just to render "as of block #N" (`:205-209`), while all data reads already refresh on 60s. Replace `watch:true` with a 60s `query.refetchInterval` (drop `watch`) so the caption refreshes on the same cadence as the data instead of holding a per-block WS/poll subscription.
- **files:** `src/pages/TreasuryPage.tsx:89`
- **effort:** S
- **risk:** low
- **test:** Manual: block caption still updates (~60s); network no longer shows per-block polling on /treasury.
- **deps:** []

### F410 — Treasury: ETH-only balance, no token holdings / history / inflow-outflow categorization (best-in-class)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Additive transparency gaps: treasury TOWELI/other token holdings (a `balanceOf` per token), historical balance/fees chart, and runway-vs-opex view (notable since self-sustain economics are the stated strategy). Token balances are cheap (a few reads); charts/runway need the indexer + an opex data source. Owner decision on scope; ship token-holdings reads as the cheap partial if desired. Overlaps F457.
- **files:** `src/pages/TreasuryPage.tsx`
- **effort:** L
- **risk:** low
- **test:** N/A until scoped.
- **deps:** [F457]

---

## Batch: copybutton-consistency

### F400 — copyAddr ignores the clipboard promise; shared CopyButton isn't used
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** `SecurityPage.tsx:113-117` calls `navigator.clipboard.writeText(addr)` with no `.catch` — on a permissions-denied / insecure context this is an unhandled rejection and the "Copied" state still shows falsely. Swap to the shared `CopyButton` primitive (used on Tokenomics/Treasury/Contracts) for consistent error handling and feedback. Replace the inline `copyAddr` + `copied` state in the contract-address rows (`:267-269`) with `<CopyButton text={c.address} … />`.
- **files:** `src/pages/SecurityPage.tsx:111-117`, `:264-269`
- **effort:** S
- **risk:** low
- **test:** Manual: copy still works; in an insecure context it fails gracefully (no false "Copied").
- **deps:** []

### F459 — Footer contract-address copy chip gives minimal feedback (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The footer copy chip (in `AppLayout.tsx` / footer component) only briefly swaps the glyph with no clear success affordance. Route it through the shared `CopyButton` (or add a green check + "Copied" tooltip like the rest of the app). Same primitive as F400. Footer is site-wide but the chip lives in the shared layout this surface renders within.
- **files:** `src/components/layout/AppLayout.tsx` (footer copy chip)
- **effort:** S
- **risk:** low
- **test:** Manual: clicking footer copy shows a clear "Copied" check.
- **deps:** []

---

## Batch: tab-host-a11y-and-mobile

### F395 — Tab bars use aria-pressed buttons not tabs semantics; every tab click pushes history
- **verdict:** fix-now
- **rootCause:** T10
- **approach:** All three hosts (`LearnPage.tsx:62-76`, `ActivityPage.tsx`, `InfoPage.tsx:69-83`) render plain `<button aria-pressed>` inside a styled div — no `role=tablist/tab`, no arrow-key nav; and `handleTab` uses `navigate(..., { replace: false })` so 5 tab flips leave 5 history entries (Back cycles tabs). Adopt the WAI-ARIA tabs pattern (tablist/tab roles, `aria-selected`, roving tabindex + arrow-key handler) and switch intra-host navigation to `replace: true` (deep links still work since the URL is the state). Factor the tab-bar into one shared component since all three hosts are near-identical — fixes all three at once and avoids re-divergence.
- **files:** new `src/components/ui/TabBar.tsx`; `src/pages/LearnPage.tsx:39-77`, `src/pages/ActivityPage.tsx`, `src/pages/InfoPage.tsx:47-84`
- **effort:** M
- **risk:** med (shared nav component across 3 hosts + history behaviour change — verify deep links and Back still behave)
- **test:** Keyboard: arrow keys move between tabs; Back from a host leaves the page (doesn't cycle tabs); axe shows tablist/tab roles.
- **deps:** []

### F402 — InfoPage 5-tab bar extremely tight on small phones
- **verdict:** fix-now
- **rootCause:** standalone (responsive)
- **approach:** `InfoPage.tsx:74` uses `text-[11.5px] px-2 whitespace-nowrap` across 5 `flex-1` buttons; at ≤380px labels clip with no overflow. Allow horizontal scroll (`overflow-x-auto` + scroll-snap) on the pill row below ~380px while keeping the current `flex-1` look on wider screens (e.g. swap `flex-1` for `flex-none` + scroll container under a breakpoint, or add `overflow-x-auto` with `min-w` pills). If F395's shared TabBar lands, bake this responsive behaviour into it.
- **files:** `src/pages/InfoPage.tsx:59-84` (or shared TabBar from F395)
- **effort:** S
- **risk:** low
- **test:** Manual at 360px: all 5 tab labels readable (scroll if needed), no clipping.
- **deps:** [F395]

---

## Batch: no-op-hover-styles

### F403 — No-op hover styles (text-white hover:text-white) on multiple links
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** Several links declare a hover transition where start and end colors are identical, giving zero hover feedback: `TokenomicsPage.tsx:189`, `:264-265`; `AdminPage.tsx:56`; `PremiumPage.tsx:486`. Use a dimmed rest state → bright on hover (`text-white/70 hover:text-white`) as ContractsPage rows already do. Mechanical multi-site edit.
- **files:** `src/pages/TokenomicsPage.tsx:189`, `:264-265`; `src/pages/AdminPage.tsx:56`; `src/pages/PremiumPage.tsx:486`
- **effort:** S
- **risk:** low
- **test:** Manual: hovering each link visibly brightens.
- **deps:** []

---

## Batch: ultrawide-layout

### F461 — Data-dense pages keep a narrow center column on ultrawide (live)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Terms/Privacy/Risks correctly keep a reading column, but /contracts (31 rows) and /treasury also confine to ~half width on a 3432px display, leaving huge empty margins. At >2000px let /contracts go two-column per section and widen the /treasury stat row (background art untouched, additive). Needs a design call on the >2000px breakpoint and which sections go two-up; low priority (ultrawide-only).
- **files:** `src/pages/ContractsPage.tsx:379-413`, `src/pages/TreasuryPage.tsx:246-260`
- **effort:** M
- **risk:** low
- **test:** Manual at 3432px: contracts render two-column, less dead margin.
- **deps:** []

---

## Batch: cross-cutting-freshness-stamps

### F414 — No last-reviewed/updated stamps on Security/Contracts/FAQ pages (best-in-class)
- **verdict:** fix-now
- **rootCause:** T4 (this is the root condition that let the Verified-badge + fee rot go unnoticed)
- **approach:** Terms/Risks/Privacy have "Last updated" stamps; Security/Contracts/FAQ don't. Add a small "Last reviewed: <date>" footer line to `SecurityPage`, `ContractsPage`, and `FAQPage` (a single dated string each) so users can tell which trust surfaces are fresh. Cheap and directly mitigates the trust-rot class. Pair with the trust-claims-honesty-pass so the stamps land already-accurate.
- **files:** `src/pages/SecurityPage.tsx` (footer), `src/pages/ContractsPage.tsx:415-418`, `src/pages/FAQPage.tsx` (footer)
- **effort:** S
- **risk:** low
- **test:** Manual: each page shows a current "Last reviewed" date.
- **deps:** [F372, F415, F380, F379, F373]

---

## Batch: contracts-best-in-class (backlog)

### F411 — Contracts: no ABI download, no deploy-date/deploy-tx link, no per-contract watch helper, no rotation diff (best-in-class)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Additive enhancements to ContractsPage rows: ABI copy/download, deployment date + deploy-tx link per contract, "add to wallet" helpers, and an address-rotation changelog. Useful but several need a data source (deploy metadata) and are multi-day. Defer to an owner scope decision; not user-blocking.
- **files:** `src/pages/ContractsPage.tsx`
- **effort:** L
- **risk:** low
- **test:** N/A until scoped.
- **deps:** []

---

## Cross-surface / site-wide findings surfaced here

These were observed while auditing this surface but their fix lives in another surface or a shared component. Logged for completeness with the owning location.

### F438 — Swap tab-pane entrance animation freezes mid-fade (forms ghosted) (live)
- **verdict:** fix-now
- **rootCause:** T2
- **approach:** This is the /swap surface (`TradePage` Liquidity/DCA/Alerts panes) — a different group's page — but it's the canonical instance of the **T2 frozen-tween**: `m.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}}` panes (`TradePage.tsx:168,488,495,507`) stick at ~0.5–0.7 opacity when the tab-switch height/layout change races the entrance tween under `LazyMotion domAnimation` (`App.tsx:221`). Fix at the source: make panes settle deterministically — add `onAnimationComplete`/`whileInView`-independent fallback that force-sets `opacity:1`, or key the pane so the entrance restarts cleanly on tab change, or use CSS `animation-fill-mode: forwards`. Belongs in the swap surface's plan; flagged here because the same entrance pattern is used across THIS surface's cards (any T2 fix should be applied consistently). Cross-reference the swap surface owner.
- **files:** `src/pages/TradePage.tsx:168,:488,:495,:507` (swap surface)
- **effort:** M
- **risk:** med
- **test:** Manual on /swap: click to Liquidity/DCA → pane settles to full opacity within ~1s; direct load of `?tab=liquidity` is not ghosted.
- **deps:** []

### F417 / F443 / F444 — First-load splash ~18–25s, not skippable, mandatory CLICK TO ENTER, replays per session (incl. deep links to /terms, /privacy; Tradermigos second gate) (live)
- **verdict:** product-decision
- **rootCause:** T11 / standalone
- **approach:** The cinematic loader (`src/components/loader/AppLoader.tsx` + `phases/`) and the Tradermigos `SplashScreen.jsx` gate every first visit (and deep links to legal pages) behind a long, non-skippable intro that ends in a click gate, and replay per browser session. Owner mandate is to **keep the art**, so this is a product-decision on timing/skip UX: add a visible Skip from second 1, make any click/keypress fast-forward, auto-enter without the click gate, remember entry once-ever in `localStorage`, and consider bypassing entirely for legal/info deep links (a user sent to /terms shouldn't watch 20s of cinema). Spans the global loader (not this surface's files) — coordinate with whoever owns the loader; listed here because it blocks first paint on Learn/Info pages too.
- **files:** `src/components/loader/AppLoader.tsx`, `src/components/loader/phases/*`, `src/nakamigos/components/SplashScreen.jsx`
- **effort:** M
- **risk:** med (touches first-paint flow for the whole app)
- **test:** Manual: deep-link to /terms in a fresh session → Skip available immediately; entry remembered next session.
- **deps:** []

### F429 / F446 — eth.llamarpc.com is down and retried first on every load (live)
- **verdict:** fix-now
- **rootCause:** standalone (site-wide infra)
- **approach:** `lib/wagmi.ts` transport `fallback([...])` lists `eth.llamarpc.com` first; it's been 5xx all session (OPTIONS 521 / POST 503) and every page pays the dead first-hop preflight before failing over to publicnode/ankr (both 200). Reorder the fallback list to put a healthy provider first (demote llamarpc), and/or add a `rank`/circuit-breaker so a failing provider is deprioritized for the session. Site-wide (`lib/wagmi.ts`), not specific to this surface, but affects its cold loads too.
- **files:** `src/lib/wagmi.ts` (transport fallback order)
- **effort:** S
- **risk:** med (RPC transport change affects the whole app — verify reads still resolve)
- **test:** Network log on cold load: first RPC hop is a 200 provider; no llamarpc 503 on the critical path.
- **deps:** []

### F433 / F450 — Mascot bubble/avatar covers the "Protocol Active" price ticker (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** The floating Towelie mascot (`TowelieAssistant.tsx`) and its speech bubble overlap the bottom-right "Protocol Active $0.0…" status chip (in `AppLayout.tsx`) whenever a tip shows — both pinned to the same corner. Offset the status chip left of / above the mascot, or shift the bubble up, so both are readable. Site-wide shared components; surfaced on this surface's pages (/admin, /history, /premium).
- **files:** `src/components/TowelieAssistant.tsx`, `src/components/layout/AppLayout.tsx` (status chip position)
- **effort:** S
- **risk:** low
- **test:** Manual: trigger a mascot tip on /admin → price ticker fully visible.
- **deps:** []

### F439 — Prod /api/opensea rejects the stats path → DEMO fallback (live)
- **verdict:** redeploy-only
- **rootCause:** T1
- **approach:** The same stats request returns 200 with real data on localhost HEAD but 400 in prod — the prod serverless function's path allowlist is stale relative to HEAD (matches the documented stale-prod diagnosis). No code change needed beyond shipping HEAD. **Redeploy prod from repo root per the documented procedure.** This is a /nakamigos surface concern; logged here because it came in the same agent batch.
- **files:** prod deploy (no code change)
- **effort:** S
- **risk:** low
- **test:** After deploy: `GET /api/opensea?path=collections/junglebay/stats` → 200; hub DEMO badge gone.
- **deps:** []

### F445 — Logged-out /swap shows zero market data (entire form replaced by connect gate) (live)
- **verdict:** product-decision
- **rootCause:** T7
- **approach:** /swap surface (another group). Render the swap form with live quoting while disconnected and make the action button the connect CTA (RainbowKit standard) — the DCA tab already does this logged-out, proving the pattern works. Also fix the gate-card alignment (button left-aligned vs centered message). Owner/swap-surface decision; logged here from the same agent.
- **files:** `src/pages/TradePage.tsx` (swap surface)
- **effort:** M
- **risk:** med
- **test:** Manual: logged-out /swap shows pair selector + quote; action button = Connect.
- **deps:** []

### F448 / F430 — Jump-scroll (End / Ctrl+Home) leaves viewport blank until a wheel scroll (live)
- **verdict:** fix-now
- **rootCause:** T2 / standalone
- **approach:** On /terms, /security (and any page), pressing End / Ctrl+Home scrolls but `whileInView`/IntersectionObserver-driven reveal animations don't fire on instant programmatic jumps, leaving sections at `opacity:0` until a wheel tick. The `m.section whileInView` entrances on RisksPage/SecurityPage/etc. and any IntersectionObserver reveal need to fire on programmatic scroll — set `viewport={{ once: true, amount: 0 }}` and/or a safety timeout that force-completes reveals for elements already in view after scroll-end. Also matters for find-in-page and the anchor deep-links (F397). Shared reveal mechanism; appears across this surface's pages.
- **files:** reveal-animation pattern across `src/pages/*` (`whileInView` usages on SecurityPage/RisksPage/TermsPage), or a shared reveal hook if one exists
- **effort:** M
- **risk:** med (touches reveal animations app-wide)
- **test:** Manual: press End on /terms → content visible immediately (no blank frame).
- **deps:** []

### F449 / F420 (theme) — Light theme incomplete: only header restyles, content stays dark (live)
- **verdict:** product-decision
- **rootCause:** T10
- **approach:** Toggling day mode sets `tegridy-theme=light` + a light body background, but content sections still paint dark — net "orange header on a dark site", and nav links (purple-on-orange) have weak contrast. Either finish light-theme coverage for the info pages or hide the toggle on pages that don't support it (current state reads as a bug). The art-panel pages are intentionally dark for art legibility, so "finish light theme" conflicts with the art mandate — this needs an owner decision (most likely: scope the toggle to where it's truly supported, or commit to a full light pass). F420 (leaderboard dark-on-dark heading) is the most acute instance and is fixed there; this is the broader theme decision.
- **files:** `src/index.css` (theme tokens), theme toggle gating in `AppLayout.tsx`
- **effort:** L
- **risk:** med
- **test:** N/A until scoped.
- **deps:** [F420]

### F453 — 21,434% APR displayed raw as headline (live)
- **verdict:** product-decision
- **rootCause:** standalone
- **approach:** Home ticker + /farm show "STAKING APR 21,434%" with an honest "early-TVL bootstrap" caption, but a 5-digit APR is a classic rug-signal to experienced users. Additively show a projected APR at a reference TVL ("at $100k TVL: ~X%") or cap the headline with a ">999%" treatment + the existing explainer tooltip. /farm + home surface (not this group); owner call on presentation. Logged from the same agent batch.
- **files:** `src/pages/HomePage.tsx`, `src/pages/FarmPage.tsx` (other surface)
- **effort:** M
- **risk:** low
- **test:** Manual: headline APR capped/contextualized.
- **deps:** []

### F454 — Revenue-destination copy conflict: "every fee funds the treasury" vs "100% to stakers" (live)
- **verdict:** fix-now
- **rootCause:** T4
- **approach:** Tradermigos hub subtitle says "every fee funds the treasury" while the footer (every page) says "100% of protocol revenue goes to stakers" and /treasury shows Stakers 100% / Treasury 0%. Align the Tradermigos line to the actual split ("1% fee — routed to stakers via the revenue distributor"). Fix lives in `src/nakamigos/App.jsx`/hub header (another surface) but it's a trust-copy contradiction in the same family as this surface's T4 batch.
- **files:** `src/nakamigos/App.jsx` (hub subtitle)
- **effort:** S
- **risk:** low
- **test:** Manual: Tradermigos subtitle matches the stakers-100% reality.
- **deps:** []

### F455 — Nakamigos hub fires 9 sequential /api/alchemy calls + slow orderbook (live)
- **verdict:** product-decision
- **rootCause:** T8
- **approach:** /nakamigos perf: batch the 9 alchemy reads (multicall or one serverless fan-out) and cache orderbook stats server-side to roughly halve hub time-to-data. Nakamigos surface (other group); owner/perf decision. Logged from the same agent batch.
- **files:** `src/nakamigos/api.js`, `/api/alchemy` serverless (other surface)
- **effort:** M
- **risk:** med
- **test:** Network: hub issues ≤2 alchemy round-trips; faster time-to-data.
- **deps:** []

### F456 — /farm logged-out hides all pool/tier data from prospective stakers (live)
- **verdict:** product-decision
- **rootCause:** T7
- **approach:** Logged-out /farm shows only stat chips + connect card; render the lock-tier/boost table and live pool stats read-only below the gate (the home calculator proves the tier data is client-side), gating only the position widgets. /farm surface (other group); additive, owner decision. Logged from the same agent batch.
- **files:** `src/pages/FarmPage.tsx` (other surface)
- **effort:** M
- **risk:** low
- **test:** Manual: logged-out /farm shows tier table + pool stats.
- **deps:** []

### F458 — Swap tab naming mismatch: "Alerts" tab → ?tab=limit → "Price Alert" title (live)
- **verdict:** fix-now
- **rootCause:** standalone
- **approach:** On /swap, the "Alerts" tab navigates to `?tab=limit` and sets title "Price Alert". Pick one name (Alerts or Limit) across the tab label, URL param, and `document.title` for shareable-URL clarity. /swap surface (other group). Logged from the same agent batch.
- **files:** `src/pages/TradePage.tsx` (other surface)
- **effort:** S
- **risk:** low
- **test:** Manual: tab label, URL param, and title agree.
- **deps:** []

### F409 — Security page: no live verification status / security.txt / contact / monitoring (best-in-class)
- **verdict:** operator-action
- **rootCause:** T4
- **approach:** A living security page would show live Etherscan verification status, a `/.well-known/security.txt`, a direct security contact (email/PGP), and monitoring/alerting status. The verification-status read depends on the operator rotating the Etherscan key + verifying sources (see F447/F372); `security.txt` + contact are small additive items the operator can decide to publish. Primarily operator/ops, with a small frontend follow-up once verification is real.
- **files:** `public/.well-known/security.txt` (new), `src/pages/SecurityPage.tsx` (status read, follow-up)
- **effort:** M
- **risk:** low
- **test:** `security.txt` resolves; verification status reads live once the key is rotated.
- **deps:** [F447]
