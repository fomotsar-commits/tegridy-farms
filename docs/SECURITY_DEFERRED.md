# Security Items Deferred — as of 2026-04-19

Items from the 2026-04-20 audit and the April 2026 critique that were **not**
addressed in the `bulletproof/batch-1-mechanical` pass. Each entry records why
it was deferred and what a follow-up looks like.

## Requires external action (user / protocol-level)

### TegridyFeeHook stranded ownership
- **Status:** live but broken — contract owned by the Arachnid CREATE2 proxy.
- **Fix:** redeploy with `_owner` argument passed explicitly, then mine a
  vanity CREATE2 salt. Already queued in [`docs/WAVE_0_TODO.md`](./WAVE_0_TODO.md).
- **Blocker:** mainnet deploy + gas + vanity salt mining (external process).

### Multisig `acceptOwnership` on 3 contracts
- **Status:** queued per `WAVE_0_TODO.md` — `TegridyLPFarming`,
  `TegridyNFTLending`, `GaugeController` await acceptance from
  `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`.
- **Blocker:** requires the multisig signers to act.

### `.env` deployer-key rotation
- **Status:** hot key still in working `.env` per `FIX_STATUS.md`.
- **Concern:** AI-agent sessions that touch `.env` may leak the key to
  provider telemetry. The April 2026 critique flagged this as "the single
  most realistic attack vector for this protocol, above all contract
  findings combined."
- **Fix:** generate a new key in a cold environment, transfer ownership of
  every contract to a Gnosis Safe, move the deployer key to a hardware
  wallet used only for proposing multisig transactions.
- **Blocker:** user-only action. Cannot be executed by an agent.

### TegridyTWAP → Chainlink / Uniswap V3 `OracleLibrary`
- **Status:** 247 LOC of custom circular-buffer TWAP still in use.
- **Concern:** custom oracles are Rekt class-A (bZx $8M, Harvest $24M,
  Cream $130M).
- **Blocker:** Chainlink feeds require a feed-request process (multi-week
  lead time). Uniswap V3 path requires a V3 TOWELI pool, which doesn't
  exist yet. Both are protocol-level decisions.

### TegridyNFTPool → Sudoswap LSSVM2 fork
- **Status:** 625 LOC of custom linear bonding curve still in use.
- **Concern:** NFT AMMs are hard to get right (Sudoswap iterated
  repeatedly); a bespoke one is a bug farm.
- **Blocker:** Sudoswap LSSVM2 is **AGPL-3.0**. Forking would propagate the
  license to the entire Tegridy codebase — a protocol-wide legal decision.

## Architectural — tractable but larger than a batch commit

### critique 5.5 `TegridyNFTLending` — per-tokenId offers (Gondi pattern)
- **Status:** collection-wide offers still supported; the lender has no
  say in *which* NFT from the collection the borrower deposits.
- **Fix:** add `uint256 tokenId` to the `Offer` struct; `createOffer` takes
  tokenId; `acceptOffer` verifies match (or drops its `_tokenId` param and
  uses the stored one).
- **Why deferred:** breaking ABI change; requires updating ~15 test
  call-sites in `TegridyNFTLending.t.sol` plus any off-chain indexer /
  frontend integration. Clean scope for a focused PR.

### critique 5.4 `TegridyLending.minPositionValue` — USD-denominated floor
- **Status (partial):** `bulletproof/batch-7d-eth-floor` adds an optional
  ETH-denominated floor (`minPositionETHValue` — 7th field of `LoanOffer`).
  When non-zero, `acceptOffer` reads `TegridyPair.getReserves()` and
  revertS `InsufficientCollateralValue` if the position's TOWELI amount
  valued at spot reserves falls below the threshold. Zero preserves the
  pre-batch behaviour.
- **Remaining risk — known, accepted:** spot reserves are manipulable in
  the same transaction (sandwich). Mitigations: lender opt-in, contract's
  2h max-manipulation bound via deadline grace window + bounded loan
  durations; the malicious price has to hold until the borrower fails to
  repay, which is expensive. `test_sandwich_sameBlockManipulation_succeeds`
  documents the risk in the test suite.
- **Full fix:** swap `_positionETHValue` for a TWAP read (TegridyTWAP once
  it's consulted by any other live integration, or Uniswap V3 OracleLibrary
  once a V3 pool exists).
- **Why still deferred:** TWAP / Chainlink dependency blockers listed
  above. The partial fix is battle-tested (OZ Math.mulDiv + the same
  reserve interface TegridyTWAP and TegridyRouter already use) and is a
  strict improvement over the TOWELI-only floor.

### H-1 JBAC flash-loan boost capture — deposit-based pattern
- **Status:** JBAC holder status cached at `stake()` via
  `jbacNFT.balanceOf(msg.sender) > 0`; the cache persists for the full
  lock duration (up to 4 years). A flash-borrowed JBAC captures the boost
  permanently.
- **Fix (battle-tested, ApeCoin Staking):** `stakeWithBoost(amount,
  duration, jbacTokenId)` — pull the JBAC into the staking contract via
  `safeTransferFrom`; +0.5x applies only while the contract holds it;
  returned on unlock. Flash-loans can't satisfy this because the NFT
  physically leaves the attacker's address for the full lock.
- **Why deferred:** changes the staking contract's constructor
  signature + lifecycle, touches `stake` / `withdraw` / `emergencyExit`
  + all 40+ test call-sites. A focused follow-up PR.

### M-5 multi-NFT voting aggregation (full fix)
- **Status:** a loud `MultipleNFTsAtAddress` event is already emitted
  ([`545308c`](../commit/545308c)). Integrators get a warning, but
  `votingPowerOf` still returns only the latest position.
- **Full fix:** aggregate voting power across all NFTs owned by an
  address via OZ `ERC721Enumerable` or a custom `EnumerableSet`.
  Restaking already aggregates correctly via its own tracking; this
  matters for contracts (e.g. a Safe multisig) that accept staking NFTs
  without internal aggregation.
- **Why deferred:** requires changing the `ERC721` base class on
  `TegridyStaking` *or* adding per-holder state + `votingPowerOf` loop.
  Non-trivial; the event warning covers the 95% case of "silent vote
  undercount" until the full fix ships.

### M-8 Supabase proxy — Zod per-table schema validation
- **Status:** the proxy validates the allowlisted table name and the
  match-filter safe-character regex, but the INSERT/UPSERT body is
  unvalidated — trust falls entirely on the RLS policy.
- **Fix:** per-table schema map in `frontend/api/supabase-proxy.js`
  (Zod). Reject bodies containing fields outside the schema; reject any
  `wallet` / `author` field that doesn't match the JWT's wallet claim at
  the proxy layer.
- **Why deferred:** frontend/API work rather than contracts; belongs in
  a separate PR touching the Supabase proxy + tests.

### Batch 5 — M-6 fee-on-transfer swap variant
- **Status:** `SwapFeeRouter.swapExactTokensForTokens` reverts on FoT
  input tokens because the underlying Uniswap V2 router does.
- **Fix:** port `*SupportingFeeOnTransferTokens` variants from UniV2
  Router02.
- **Why deferred:** additive (new function), but requires careful
  balance-delta accounting in the SwapFeeRouter fee-take path. Clean
  follow-up batch.

### ~~Delete V1 duplicate contracts (`TegridyLaunchpad`, `TegridyDrop`)~~ — **DONE 2026-04-19**
Completed on branch `bulletproof/v1-deletion`. V1 `.sol` sources deleted
(`TegridyLaunchpad.sol`, `TegridyDrop.sol`, `TegridyLaunchpad.t.sol`),
`DeployV3Features.s.sol` + `scripts/redeploy-patched-3.sh` removed,
V1 ABI / address / factory wiring stripped from `frontend/src/lib/contracts.ts`,
`constants.ts`, `wagmi.config.ts`, `abi-supplement.ts`, `ContractsPage.tsx`,
`LaunchpadSection.tsx`, `useNFTDrop.ts`, `OwnerAdminPanel.tsx`. V1 mainnet
clones remain live and readable through the V2 Drop ABI (strict superset at
the read surface).

## Docs / operational hygiene

### Consolidate 7+ audit files into a single canonical source
- **Status:** `SECURITY_AUDIT_OPUS.md`, `SECURITY_AUDIT_40_AGENT.md`,
  `SECURITY_AUDIT_200_AGENT.md`, `SECURITY_AUDIT_300_AGENT.md`,
  `SECURITY_AUDIT_FINAL.md`, `SECURITY_AUDIT_REPORT.md`,
  `SPARTAN_AUDIT.txt`, `AUDIT_FINDINGS.md`, `AUDITS.md`,
  `tegridy_100_findings.docx`, `findings_text.txt`, `findings_clean.txt`
  all coexist with no canonical ID space.
- **Fix:** keep one `AUDIT_FINDINGS.md`, normalise to a single ID
  scheme (H-xx / M-xx / L-xx), mark each finding as
  `open | fixed | accepted-risk | deferred`, delete the rest.
- **Why deferred:** doc refactor — not security work per se; this file
  (`SECURITY_FIXES_2026-04-19.md` + `SECURITY_DEFERRED.md`) is the
  interim canonical status for this pass.

## Post-merge audit sweep (2026-04-20) — accepted-risk findings

The 5-agent + Slither audit pass over the merged `bulletproof/batch-1-mechanical`
branch produced the items below. Each has been triaged and is intentionally NOT
fixed in the mechanical-fix pass — either because the blocker is external, the
cost exceeds the benefit, or the mitigation is already in place and can only be
improved with a larger architectural change.

### `TegridyLending._positionETHValue` spot-price sandwich
- **Status:** HIGH severity if the lender opts in (`minPositionETHValue > 0`).
- **Surface:** `acceptOffer` reads `TegridyPair.getReserves()` directly at accept
  time. Same-block sandwich is possible.
- **Why accepted:** the lender opts in explicitly; default is 0 (disabled). The
  2-hour loan-acceptance deadline bounds the exposure window. Migrating to TWAP
  requires the TegridyTWAP → Chainlink swap already deferred above. In the
  interim lenders should leave `minPositionETHValue = 0` unless they have a
  private-mempool RPC or can monitor for sandwich attempts.

### `VoteIncentives` commit-reveal residual see-then-vote
- **Status:** MEDIUM — economic agent estimated $50-200K/year theoretical capture.
- **Surface:** commit window (40% of VOTE_DEADLINE = 2.8 days) is fully
  observable. An attacker can commit at the start, monitor bribes, reveal late
  with knowledge of the full bribe set and their own proportional share.
- **Why accepted:** inherent tradeoff of on-chain commit-reveal; fully hiding
  commit timing would require zk or off-chain sealed-bid. The 10 TOWELI bond
  per commit + MIN_BRIBE_AMOUNT floor reduce the economic payoff.
- **Cheap mitigation available:** raise `MIN_BRIBE_AMOUNT` from 0.001 ETH
  toward 0.1 ETH on L1 (0.01 on L2). Makes dust-bribe filler griefing more
  expensive and reduces the see-then-vote payoff per observable bribe. Not
  landed in this pass — single-line constant change, acceptable follow-up.

### `POLAccumulator.accumulate` MEV visibility
- **Status:** HIGH severity if the operator submits via public mempool.
- **Surface:** the swap + LP add is visible ≥1 block ahead of inclusion.
- **Why accepted:** no on-chain mitigation possible for a predictable owner-
  triggered swap-and-add. The contract already documents Flashbots-Protect as
  a requirement and caps slippage at 5%. Enforcement is operational, not
  technical.

### `TegridyTWAP` multi-block price-deviation gaming
- **Status:** MEDIUM — independent audit flagged the 50% deviation gate only
  compares against the previous observation, not an absolute floor.
- **Why accepted:** already captured above under "TegridyTWAP → Chainlink /
  Uniswap V3 `OracleLibrary`." The fix is the oracle swap, not a patch.

### 50k-gas stipend DoS risk on `distribute()` paths
- **Status:** MEDIUM — if `revenueDistributor` or `polAccumulator` is ever
  pointed at a contract whose `receive()` needs >50k gas, `distributeFeesToStakers`
  reverts on the `require(ok, ...)`.
- **Why accepted:** both destinations are protocol-governed with 48h timelock
  changes and minimal `receive()` (event emit only). Raising to 100k doubles the
  reentrancy surface without meaningful benefit. A future governance migration
  to a complex router destination would require re-auditing this path.

### Stray files at repo root
- **Status:** 25 Markdown files + previously-stray IMG/video files at
  the repo root. The iPhone images and videos were moved into
  `frontend/public/art/iphone/` and `frontend/public/videos/` during
  this pass (commit for the art-studio update). 46 plain numbered JPGs
  (`1.jpg`, `10.jpg`, etc.) remain — these are duplicates of
  `frontend/public/splash/new/` and should be deleted.
- **Why deferred:** minor hygiene; queue for a separate commit.
