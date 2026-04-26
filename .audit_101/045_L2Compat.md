# Agent 045 — L2 Compatibility Audit (AUDIT-ONLY)

Scope: `contracts/src/*` (28 files) + `contracts/test/L2Compatibility.t.sol`
Pragma: `^0.8.26` everywhere (push0 ✓ — needs Cancun-or-later L2; Optimism Bedrock+ OK, Arbitrum Nitro post-2023 OK, Base/Linea/zkSync Era have caveats — see below)

---

## Surface Counts

| L2-relevant primitive                     | Hit count |
|------------------------------------------|----------:|
| `block.timestamp` reads/writes            | ~190 across 25 files |
| `block.number`                            | **0** (only legacy comments noting M-36 fix) |
| `blockhash` / `block.basefee` / `block.coinbase` / `block.prevrandao` / `block.difficulty` | **0** |
| `block.chainid`                           | 2 (commit-hash binding in GaugeController, VoteIncentives) |
| `selfdestruct`                            | 0 |
| `address(this).code` / `extcodesize`      | 0 / 0 |
| `target.code.length` checks               | 7 (TegridyFactory ×2, TegridyNFTPoolFactory ×1, TegridyStaking ×2, VoteIncentives ×1, ERC1820 probe ×1) |
| `gasleft()` / refund assumptions          | 0 |
| Inline assembly                           | 1 (`TegridyFactory.createPair` CREATE2) |
| EIP-1153 transient storage / MCOPY        | 0 |
| `SafeCast.toUint48(block.timestamp)`      | 2 (TegridyStaking checkpoints — Trace208/uint48) |
| `uint32(block.timestamp)` truncations     | 2 (TegridyTWAP, TegridyPair — Uniswap V2 parity) |
| Sequencer-uptime-feed integrations        | **0** |
| Chainlink AggregatorV3 / oracle adapters  | **0** (only doc references) |
| L1Block / ArbSys / cross-domain precompiles | **0** |

Test file: 7 tests, all targeting TegridyStaking + RevenueDistributor + PremiumAccess. **22 of the 25 timestamp-dependent contracts have ZERO L2 coverage.**

---

## Findings

### HIGH

**[H1] Arbitrum L2 timestamp can lag L1 by up to ~24h — short cooldowns and reveal windows are NOT validated against the worst-case skew.**
On Arbitrum One, `block.timestamp` reflects the sequencer's view of L1 time and is *upper-bounded by L1 wall-clock + ~3h forward and lower-bounded ~24h backward* (per Offchain Labs spec). For Tegridy this means:
- `MIN_ACTIVATION_DELAY = 15 seconds` (`PremiumAccess.sol:63`) — single sequencer-skew tick can satisfy or skip this. Test only checks the boring path (`highTs + 15s + 1`); it does NOT simulate sequencer skew (`vm.warp` going *backwards* and forwards). Flash-loan window can be re-opened during a sequencer freeze.
- `TRANSFER_RATE_LIMIT = 1 hour` (`TegridyStaking.sol:60`) — if sequencer was down for 90 min then resumes with timestamps backfilled, a single block can satisfy the rate-limit for many tokens that previously couldn't transfer.
- `MIN_DISTRIBUTE_INTERVAL = 4 hours` (`RevenueDistributor.sol:107`), `MIN_EPOCH_INTERVAL = 7 days` (`VoteIncentives.sol:88`), `SYNC_COOLDOWN` (`TegridyFeeHook.sol:303`) — same class.
- `REVEAL_WINDOW = 24 hours` (`GaugeController.sol:48`): if Arbitrum sequencer is down for the entire reveal window of an epoch, **all commits forfeit** with no fallback. There is no force-include-via-L1 escape hatch.
- `SNAPSHOT_LOOKBACK = 1 hour` (CommunityGrants, MemeBountyBoard, VoteIncentives): on a chain where timestamps can jump 10+ minutes, the snapshot can land *inside* the staking window of an attacker who staked seconds before proposal creation. The lookback was sized for L1's 12s blocks — not for a chain that can produce a 1h timestamp gap from a sequencer restart.

**[H2] `TegridyTWAP` and `TegridyPair` use `uint32(block.timestamp)` — wrap year is 2106 on L1 but can be NOW on chains with high genesis offsets.**
`TegridyTWAP.sol:137` and `TegridyPair.sol:298` truncate to `uint32`. The contract has wrap-aware diff math (NEW-G6) and is correct for Ethereum/Arbitrum/Optimism/Base genesis offsets. **However**, exotic L2/L3s (custom rollups, app-chains, testnets with synthetic timestamps) can have block.timestamp values seeded from arbitrary epochs. `MAX_STALENESS = 2 hours` (`TegridyTWAP.sol:70`) compares `block.timestamp - latest.timestamp` as `uint256` while observations are `uint32` — a single wrap during low-activity creates a stale window where the diff appears > 2h and reverts every consult, freezing every consumer that uses the oracle for liquidations / TWAP gating. **Not tested.**

**[H3] No sequencer-uptime-feed integration anywhere in the codebase.**
Standard L2 best-practice (Chainlink CCIP-Read or `AggregatorV3Interface(L2_SEQUENCER_UPTIME_FEED).latestRoundData()`) is to gate price-sensitive paths during sequencer outages. Tegridy has 0 integrations. Affected paths that SHOULD gate:
- `POLAccumulator.accumulate()` — performs swap+LP-add; sequencer-reboot price spike sandwiches this.
- `TegridyLending.liquidate` / `TegridyNFTLending.claimDefault` — `GRACE_PERIOD = 1 hour` is shorter than typical sequencer downtime windows, so loans get liquidated *immediately on resume* before borrowers can repay.
- `TegridyTWAP.consult()` — returns a price computed across a downtime gap with no flag.
- `MemeBountyBoard.cancelBounty/forceCancelBounty` — cancellation deadlines run during downtime, robbing creators.
- `CommunityGrants` voting/execution windows — same.

### MEDIUM

**[M1] `TegridyStaking._checkpoints` keys on `uint48` — `vm.warp` past `2^48-1` will revert SafeCast on every position write, but the test's `test_staking_uint64TimestampRange` already noticed this. The doc fix is in the test file; the *contract* still hard-reverts at year ~8.92M, which is fine, BUT `votingPowerAtTimestamp(user, ts)` (line 384) does the same `SafeCast.toUint48(ts)` — meaning any external consumer that passes a future timestamp in `ts > 2^48-1` reverts. RevenueDistributor and VoteIncentives both compute `block.timestamp - SNAPSHOT_LOOKBACK`; if a chain ever serves `block.timestamp > 2^48-1` the entire distribute/epoch flow bricks. Untested.

**[M2] `TegridyStaking` rate-limit `lastTransferTime[tokenId]` initialized to 0 — first transfer always passes. On L2s with skewed timestamps, this is fine but if an attacker can predict the sequencer's first post-restart timestamp they can chain mint→transfer with no rate-limit. Not L2-unique but worth noting.

**[M3] `code.length` checks in `TegridyStaking._update` (lines 898, 929) and `VoteIncentives.sol:966` are evaluated at *transfer/call time*, not construction. Behaviour differs during construction (codesize is 0 mid-`constructor` execution). This is the standard EVM behaviour, but on L2s where 4337 account-abstraction wallets self-delegate calls during deployment, the `to.code.length == 0` "is EOA" check returns true mid-deploy → second-NFT guard skipped → an AA wallet under deployment can receive multiple staking NFTs and bypass `AlreadyHasPosition`. **Not in test.**

**[M4] No CommunityGrants/GaugeController/MemeBountyBoard/POLAccumulator/SwapFeeRouter/TegridyLending/TegridyNFTLending/TegridyLPFarming/TegridyRestaking/TegridyTWAP/TegridyFeeHook/ReferralSplitter/TegridyDropV2/TegridyFactory/TegridyPair/TegridyNFTPool tests** in `L2Compatibility.t.sol`. 22 of 25 timestamp-dependent contracts have **zero L2 coverage**. The covered surface is staking/revdist/premium only — leaving TWAP, lending grace periods, gauge reveal windows, bounty deadlines, fee-hook cooldowns, referral cooldowns, drop dutch-auction timing, and POL accumulator cooldowns all UNVERIFIED for L2 timestamp semantics.

**[M5] `TegridyDropV2.getCurrentDutchPrice` (line 322): `block.timestamp - dutchStartTime` on L2 with sequencer freeze causes the dutch price to crash dramatically the moment the sequencer resumes — buyers who had pending txs at start-time get them included at floor price. No L2-aware ramp. Not tested.

### LOW / INFO

**[L1] Pragma `^0.8.26` requires push0 + MCOPY (Cancun)**. zkSync Era did not support push0 until late 2024; Linea, Scroll, and other zkEVMs may have edge cases on certain compilers. No compatibility table or deploy guard exists. Recommend documenting which L2s are supported targets and asserting via `--evm-version` per-chain. Not tested.

**[L2] `block.chainid` is used for replay protection in commit hashes** (`GaugeController.sol:293`, `VoteIncentives.sol:1025`). Correct. No L2-unique issue.

**[L3] No `ArbSys` / `L1Block` / cross-domain message integration.** This is fine for a single-chain deploy, but if Tegridy ever bridges, none of `msg.sender` aliasing (Arbitrum applies `+0x1111000000000000000000000000000000001111` on L1→L2 retryables) is handled in any owner/admin path. If treasury/owner is set to an L1 address by mistake, `acceptOwnership` calls from the alias will not match `pendingOwner`. **Pre-emptive note for cross-chain plans.**

**[L4] `TegridyTWAP.MIN_PERIOD = 15 minutes`** assumes ~1 update per period is feasible. On chains with very high gas, a `updateFee` can make this prohibitive; on chains with very fast blocks, MIN_PERIOD may be coarser than needed. Acceptable.

**[L5] `TegridyPair.blockTimestampLast` is `uint32`** but only used for the V2-parity `getReserves()` interface; no internal logic depends on it. Safe.

---

## What L2Compatibility.t.sol Does NOT Cover

1. **Sequencer downtime simulation.** No test warps backward then forward to simulate a sequencer freeze + catch-up. All `vm.warp` calls go monotonically forward.
2. **No sequencer-uptime feed integration tested** because none exists.
3. **TWAP wrap-around at uint32 boundary** — the contract has wrap-aware logic but no test verifies it on L2-like timestamps.
4. **Lending grace-period race** during simulated downtime — borrower's repayment window vanishing on resume.
5. **Dutch auction price collapse** on TegridyDropV2 across a sequencer gap.
6. **Reveal-window forfeiture** on GaugeController/VoteIncentives if a 24h sequencer outage spans the reveal window.
7. **Bounty deadline** behaviour on MemeBountyBoard during downtime.
8. **POLAccumulator cooldown** behaviour during downtime.
9. **Referral cooldown / forfeiture window** on ReferralSplitter.
10. **`code.length` semantics** during AA wallet deployment (4337 contracts).
11. **uint48 SafeCast revert** on any timestamp-dependent staking flow at upper bound — only the constructor-time path is tested.
12. **L1->L2 alias `msg.sender` rewriting** for any owner path (no test, no guard).

---

## Files of Interest (absolute paths)

- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyTWAP.sol` (uint32 wrap, no sequencer feed)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyPair.sol` (uint32 timestamp last)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyLending.sol` (1h grace, no L2 awareness)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTLending.sol` (1h grace)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\GaugeController.sol` (24h reveal window)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\PremiumAccess.sol` (15s activation)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyStaking.sol` (uint48 checkpoint, code.length AA gap)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\POLAccumulator.sol` (TWAP-priced swap, no sequencer feed)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyDropV2.sol` (dutch auction price)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\test\L2Compatibility.t.sol` (only 3 contracts covered)

---

## Top 3 Priorities

1. **Add Chainlink L2 sequencer-uptime feed** (or equivalent) on every price-sensitive path: TWAP consult, POL accumulate, lending liquidate, drop dutch-auction, bounty cancel — gate with `if (sequencerDown || gracePeriod) revert`.
2. **Test sequencer-downtime semantics** (`vm.warp(now); vm.warp(now+24h); ...`) for all 22 currently-unverified contracts in `L2Compatibility.t.sol`. Especially: GaugeController reveal window, lending grace, drop dutch-auction.
3. **Document supported L2 targets** in a compat matrix (Arbitrum One ✓, Optimism ✓, Base ✓, zkSync Era ?, Linea ?, Scroll ?, Polygon zkEVM ?). Pin compiler `--evm-version` per chain to avoid push0/MCOPY surprises on chains that lag Cancun. Add a `SequencerUptimeFeed` immutable + `_checkSequencer` modifier that any production contract can opt into.

---

End of agent 045 report.
