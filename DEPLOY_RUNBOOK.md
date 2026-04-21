# Deployment Runbook — Audit-Remediation Redeploy

**Baseline commit:** `714d839`
**Tip commit:** `25014a0`
**Span:** 18 commits, 13 contracts touched, 480 net source lines added
**Audit cross-reference:** SECURITY_AUDIT_300_AGENT.md · SPARTAN_AUDIT.txt · API_INDEXER_AUDIT.md

This runbook is the authoritative deploy plan for shipping the audit-remediation batch to mainnet. Do NOT skip sections — one contract (TegridyLPFarming) must be paused **before** its replacement is deployed, and two contracts have storage-layout impact that affects upgrade or redeploy strategy.

---

## 1. Contract change inventory

| Contract | Severity of changes | Storage layout | Action |
|---|---|---|---|
| **TegridyLPFarming** | **CRITICAL** (C-01 ABI mismatch + defence-in-depth cap) | unchanged | **Pause + migrate** (if live) |
| TegridyStaking | HIGH (lending whitelist, autoMaxLock preservation, GaugeController TF-04 interface, totalLocked cleanup) | new storage slots | Redeploy OR migrate |
| TegridyLending | HIGH (grace period, lending caps to state vars, cross-contract whitelist integration) | **const → state** | Redeploy (not upgradeable) |
| TegridyNFTLending | HIGH (createOffer nonReentrant) | unchanged | Redeploy |
| TegridyNFTPoolFactory | HIGH (CREATE2 cloneDeterministic) | unchanged | Redeploy; pool address scheme changes |
| TegridyNFTPool | MEDIUM (delta cap 100→10 ETH) | unchanged | Redeploy |
| TegridyRestaking | HIGH (unsettled-delta race fix, principal-reservation in recoverStuckPrincipal) | **new field in RestakeInfo** | Redeploy (fresh restakers table) |
| ~~TegridyLaunchpad~~ | ~~MEDIUM (fee cap 100% → 10%)~~ | ~~unchanged~~ | **RETIRED 2026-04-19** — V1 source deleted, patched fixes carried forward in `TegridyLaunchpadV2`. |
| ~~TegridyDrop~~ | ~~HIGH (Dutch auction precision, Merkle leaf domain separator)~~ | ~~unchanged~~ | **RETIRED 2026-04-19** — V1 source deleted. `TegridyDropV2` already applies the Merkle leaf domain separator + Dutch auction precision fixes. Re-issue Merkle trees with the new leaf format when deploying V2 drops. |
| TegridyRouter | LOW (natspec-only + MAX_DEADLINE 30m→2h) | unchanged | Redeploy |
| SwapFeeRouter | MEDIUM (MAX_DEADLINE 30m→2h, isPremiumAccessHealthy view) | unchanged | Redeploy |
| GaugeController | CRITICAL (epoch-0 vote collision bug fix), HIGH (TF-04 epoch-snapshot voting) | **new mapping added** | Redeploy |
| ReferralSplitter | LOW (circular-depth 10→25) | unchanged | Redeploy |

Not changed this session (no deploy needed): TegridyPair, TegridyFactory, CommunityGrants, MemeBountyBoard, POLAccumulator, PremiumAccess, TegridyFeeHook, TegridyTokenURIReader, TegridyTWAP, VoteIncentives.

---

## 2. Storage-layout details

Two contracts gained new storage. If either is currently deployed behind an upgrade proxy, the new fields MUST be appended (they already are in the diffs — verified). If they are deployed as standalone non-upgradeable contracts, full redeploy is the only path.

### TegridyRestaking — `RestakeInfo.unsettledSnapshot`
Added at the end of the struct. Also added a top-level `totalActivePrincipal` state variable (H-1 fix). Both additions are append-only — no existing slot re-typed or reordered.

**Migration consequence (non-upgradeable redeploy):** old `restakers` mapping data is lost. All restakers must re-deposit. Frontend must prompt for re-restake.

### TegridyLending — caps constants → state
Converted `MAX_PRINCIPAL`, `MAX_APR_BPS`, `MIN_DURATION`, `MAX_DURATION` from `constant` to state variables. Four new pending-value slots (`pendingMaxPrincipal` etc) and four new timelock keys.

**Migration consequence (non-upgradeable redeploy):** prior offers + loans are lost. Communicate to existing lenders/borrowers before deprecating the old contract. Consider letting the old contract finish out active loans while new origination happens only on the new contract.

### GaugeController — `hasVotedInEpoch` mapping (batch 6 fix)
Replaced the broken `lastVotedEpoch[tokenId] == epoch` guard with `hasVotedInEpoch[tokenId][epoch]`. New mapping appended.

**Migration consequence:** new contract has empty vote history. For continuity, consider snapshotting the old contract's `gaugeWeightByEpoch` and replaying as admin-set initial weights.

### TegridyStaking — `isLendingContract` + pending-lending-contract slots (batch 5)
Added new mapping + two pending-change slots. Append-only.

**Migration consequence:** after deploy, owner must call `proposeLendingContract(TegridyLending, true)` + `proposeLendingContract(TegridyNFTLending, true)`, wait 48h per the existing timelock pattern, then execute both.

---

## 3. Deploy order (strict)

Contracts must be deployed in this order because later contracts reference earlier addresses at construction. Deploy one, wait for confirmation, paste the address into the next contract's args.

```
1. TegridyStaking              (no constructor deps on these changes)
2. TegridyRestaking            (reads TegridyStaking)
3. GaugeController             (reads TegridyStaking)
4. TegridyLending              (reads TegridyStaking)
5. TegridyNFTLending           (standalone)
6. TegridyNFTPool + Factory    (redeploy pair; Pool implementation → Factory)
7. TegridyLaunchpadV2 + DropV2 (DropV2 template auto-deployed by V2 factory constructor)
8. TegridyRouter + SwapFeeRouter (no new deps)
9. ReferralSplitter            (standalone)
10. TegridyLPFarming           (reads TegridyStaking via corrected interface)
```

Post-deploy wiring, in this exact order:
1. `TegridyStaking.proposeLendingContract(tegridyLendingAddress, true)` — wait 48h — `executeLendingContract()`
2. `TegridyStaking.proposeLendingContract(tegridyNFTLendingAddress, true)` — wait 48h — `executeLendingContract()`
3. `TegridyStaking.proposeRestakingContract(restakingAddress)` — wait 48h — `executeRestakingContract()`
4. `GaugeController.proposeAddGauge(gaugeA)` + peer gauges — wait 24h — `executeAddGauge()` for each
5. Fund TOWELI to all reward-paying contracts

---

## 4. C-01 pause-and-migrate (TegridyLPFarming only)

If the old TegridyLPFarming is live, the ABI-mismatch exploit is active. Do this BEFORE deploying the fix:

1. **Pause the old contract.** `oldLPFarming.pause()` as owner. This stops `stake()`, `withdraw()`, and `getReward()` paths — the three routes that hit `_getEffectiveBalance`.
2. **Notify stakers.** Post a community announcement that the contract has been paused pending a security fix. Include the audit reference.
3. **Inventory balances.** Snapshot `rawBalanceOf[user]` for every staker via off-chain indexer. Compare against on-chain state. If any user's `effectiveBalanceOf` exceeds `rawBalanceOf * 4.5` (the post-fix ceiling), they have already exploited; decide policy (restore to ceiling vs keep as-is).
4. **Deploy the new TegridyLPFarming.** Use the same `rewardToken`, `stakingToken`, `tegridyStaking` addresses.
5. **Fund new contract.** Transfer the old contract's `rewardToken.balanceOf()` to the new one (minus any legitimate pending claims).
6. **Reopen staking on the new contract.** Users re-stake; their raw balances and correct boost now apply.
7. **Keep the old paused contract.** Do NOT `unpause()` ever. Leave it as a tombstone with the balances locked so forensics can reconstruct any attempted drain.

If the old LPFarming was never deployed live, skip this section — just deploy the new one in normal order.

---

## 5. Frontend coupling

The frontend (`frontend/src/lib/constants.ts`) hardcodes contract addresses. After deploy, update ALL of these in one PR:

| Constant | Update to |
|---|---|
| `TEGRIDY_STAKING_ADDRESS` | new staking address |
| `TEGRIDY_RESTAKING_ADDRESS` | new restaking address |
| `GAUGE_CONTROLLER_ADDRESS` | new gauge controller |
| `TEGRIDY_LENDING_ADDRESS` | new lending address |
| `TEGRIDY_NFT_LENDING_ADDRESS` | new NFT lending |
| `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` | new factory |
| `TEGRIDY_LAUNCHPAD_V2_ADDRESS` | new launchpad V2 (V1 `TEGRIDY_LAUNCHPAD_ADDRESS` retired 2026-04-19) |
| `TEGRIDY_ROUTER_ADDRESS` | new router |
| `SWAP_FEE_ROUTER_ADDRESS` | new SwapFeeRouter |
| `REFERRAL_SPLITTER_ADDRESS` | new referral |
| `LP_FARMING_ADDRESS` | new LP farming |

Then run `npm run wagmi:generate` to refresh `src/generated.ts` — without this, wagmi calls will hit the old addresses and silently fail or revert. CI should block merge if `generated.ts` diff is non-empty (audit M-7 follow-up).

Additionally, re-generate any Merkle trees used for `TegridyDropV2` allowlists. The leaf format changed from `keccak256(msg.sender)` to `keccak256(abi.encodePacked(address(this), msg.sender))`. Old proofs will not verify against new drops. (V1 `TegridyDrop` source was deleted 2026-04-19; historical V1 clones remain live and use the original leaf format.)

---

## 6. Indexer re-sync

Batch 14 added three new tables (`restakingClaim`, `bribeClaim`, `proposalVote`) and changed the handler logic for 6 events. Re-sync from the deployment block:

1. `cd indexer`
2. Update `ponder.config.ts` contract addresses to the new deploy addresses.
3. Update `startBlock` per contract to the deployment block (was `24500000`, now contract-specific).
4. Drop the existing indexer database: `rm -rf .ponder/`
5. `npm run codegen` to regenerate typed modules (if the Node 24 issue persists, run codegen on Node 20 LTS).
6. `npm run start` to re-sync from scratch.

Expect ~30–60 min for a fresh mainnet sync depending on RPC provider. The new RPC timeout + retry (INDEXER-M1) means transient upstream flakes no longer stall sync.

---

## 7. Post-deploy verification checklist

Run through this list before announcing the migration complete.

### Smart contract invariants
- [ ] `TegridyLPFarming._getEffectiveBalance(user, raw)` never exceeds `raw * 45000 / 10000` for any active user (C-01 regression)
- [ ] `TegridyNFTLending.createOffer` reverts when called while paused
- [ ] `TegridyStaking.isLendingContract[TegridyLending]` is `true` after timelock
- [ ] `TegridyStaking.isLendingContract[TegridyNFTLending]` is `true` after timelock
- [ ] `TegridyLending.GRACE_PERIOD() == 1 hours`
- [ ] `TegridyLending.maxPrincipal()` is readable and equal to 1000 ether (state var, not constant)
- [ ] `TegridyNFTPoolFactory.createPool(...)` with identical args from two different senders produces different pool addresses (CREATE2 salt works)
- [ ] `TegridyDropV2` allowlist mint with a proof generated from the old (V1) leaf format reverts with `InvalidProof`
- [ ] `GaugeController.vote(tokenId, gauges, weights)` succeeds on epoch 0 (C-01 of batch 6 regression)

### Frontend integration
- [ ] Dashboard loads without console errors against new addresses
- [ ] Farm page stake/unstake UI round-trip works
- [ ] NFT Finance page shows outstanding loans (batch 0 feature)
- [ ] Swap receipts link to the correct block explorer (batch 1 fix)
- [ ] `useFarmActions` pendingEth guard fires when user has unclaimed revenue (batch 10 TF-03)
- [ ] Trade page connect-wallet-to-swap copy visible when disconnected

### API / session
- [ ] SIWE nonce → sign → JWT cookie flow works end-to-end
- [ ] `/api/auth/me` returns 401 for expired tokens (batch 13 JWT alg pin doesn't break normal path)
- [ ] `/api/etherscan` rejects `endblock - startblock > 10000` (batch 13 M6)
- [ ] `/api/opensea` rejects any URL-encoded path (batch 13 M5)

### Indexer
- [ ] Re-sync completes without errors to current block
- [ ] `restakingClaim` table populated after a test BonusClaimed event
- [ ] `bribeClaim` table populated after a test BribeClaimed
- [ ] `proposalVote` table populated after a test ProposalVoted
- [ ] No phantom 0x0-address rows in `stakingAction` / `loan` / `proposal` / `bounty`

---

## 8. Rollback plan

If any post-deploy check fails, decide per-category:

- **New contract bug discovered:** pause the affected contract immediately (all new deploys include `pause()` onlyOwner). Investigate; do NOT unpause until a patch is ready. Users with funds still in the old paused contract are unaffected.
- **Frontend broken against new addresses:** revert the constants PR; frontend goes back to old addresses, breaking the new deploy but restoring UX. Fix, re-PR, re-deploy.
- **Indexer data corrupted:** re-sync from scratch; downstream queries go blank for 30–60 min. Document in the status page.
- **C-01 migration went wrong (e.g. stakers lost positions):** CANNOT ROLLBACK the old contract (it's paused permanently by policy). Decide compensation policy; forensics on the drain.

---

## 9. Communication template

Minimum notice to community before and after deploy:

**T-48h (before deploy):**
> We are migrating the Tegridy Farms protocol contracts to address findings from the recent security audit. The migration will require all stakers to re-stake, all lenders/borrowers to re-initiate open positions, and all allowlisted NFT drops to re-issue proofs. The app will be briefly unavailable during the cutover. Full details: [link to this runbook on IPFS or similar].

**T-0 (deploy complete):**
> Migration complete. New contract addresses: [list]. Please re-stake / re-authorize / re-initiate at [app URL]. The old contracts are paused and no longer accept new operations. If you had a position on the old contract, see the migration guide at [link].

---

## 10. Known trade-offs and deferred items

Documented so future contributors don't re-solve them:

- **H-2 commit-reveal voting** — design spec in `DESIGN_H2_COMMIT_REVEAL_VOTING.md`, not implemented. Requires governance sign-off on 5 open questions.
- **API-M1 real rate limiting** — cosmetic headers today; real enforcement needs Upstash / Vercel Edge Config / sliding-window pick.
- **Spartan TF-13 orphaned bribes** — 30-day rescue delay accepted as-is.
- **Framer-motion in critical path** — LazyMotion refactor deferred; measurable LCP win sits on the shelf.
- **Off-chain voting collusion** — not fixable at the contract layer.

---

*End of deploy runbook. Treat steps 4 (C-01 pause-and-migrate) and 7 (verification) as gates, not suggestions.*
