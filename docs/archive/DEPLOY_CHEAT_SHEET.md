# Deploy Cheat Sheet — Audit Remediation Broadcast

Companion to `DEPLOY_RUNBOOK.md`. This doc is the paste-ready operator view: the exact commands to run in order, the edits to make between steps, and the post-deploy mechanical updates. Assumes no users / no funds on the existing deployment.

**Source of truth for addresses and args:** `contracts/script/DeployFinal.s.sol` + `DeployV3Features.s.sol` + `DeployNFTLending.s.sol` + `DeployGaugeController.s.sol` + `DeployVoteIncentives.s.sol` + `DeployLPFarming.s.sol`.

**Tagged commit:** `audit-remediation` → `a2cdcad` (confirmed clean compile, 66/66 forge test suites pass).

---

## 0. Prerequisites (once, before first broadcast)

In `contracts/.env`, confirm set:
```
PRIVATE_KEY=<deployer EOA, funded with ≥ 0.4 ETH mainnet>
MULTISIG=<multisig address to receive ownership>
ETHERSCAN_API_KEY=<for source verification>
ETH_RPC_URL=<mainnet RPC — must be archive-capable>
```

`eth.llamarpc.com` is fine for broadcast but not for local simulation. If you want to dry-run against fork first, use Alchemy/Infura.

`cd contracts` for every step below.

---

## 1. Known gaps to resolve BEFORE broadcasting

### Gap A — stale hardcoded staking address in 3 satellite scripts

Three scripts hardcode the pre-remediation `TegridyStaking` address. They must point at the NEW staking that Step 2 below will deploy.

**Two ways to handle this.** Pick one before you broadcast satellites (Steps 3–7):

**Option A1 — one-liner sed after Step 2** (lower surface area, **SELECTED**):
```bash
NEW_STAKING=0x...   # from Step 2 output
# Sweep all four scripts in one pass (GaugeController, V3Features, TokenURIReader share 0x65D8…, VoteIncentives has a different old addr 0x6266…)
sed -i "s/0x65D8b87917c59a0B33009493fB236bCccF1Ea421/$NEW_STAKING/g" \
  script/DeployGaugeController.s.sol \
  script/DeployV3Features.s.sol \
  script/DeployTokenURIReader.s.sol
sed -i "s/0x626644523d34B84818df602c991B4a06789C4819/$NEW_STAKING/g" \
  script/DeployVoteIncentives.s.sol
forge build --skip test  # confirm still compiles (expect exit 0)
```

**Option A2 — convert the three `address constant` lines to read env var.** Change each `address constant TEGRIDY_STAKING = 0x…;` into:
```solidity
address TEGRIDY_STAKING = vm.envOr("TEGRIDY_STAKING", address(0x65D8b87917c59a0B33009493fB236bCccF1Ea421));
```
(store the fetched value into a `run()`-local variable instead of a file-scoped constant). Then set `TEGRIDY_STAKING=$NEW_STAKING` in env between steps. Preserves the fallback for legacy re-runs.

Either approach is fine; A1 is 1 line of ops, A2 is a reusable refactor.

### Gap B — ship audit-fixed `TegridyLPFarming` (SELECTED: B2)

User selected B2. A dedicated deploy script `script/DeployTegridyLPFarming.s.sol` ships the C-01-fixed boosted contract. It reads `TEGRIDY_LP` and `TEGRIDY_STAKING` from env vars (no stale-address problem). Use this in Step 8, not the old `DeployLPFarming.s.sol`.

The old `script/DeployLPFarming.s.sol` is left in the repo for archival reference but is not part of this deploy.

### Gap C — `TEGRIDY_LP` env var not set

`DeployLPFarming.s.sol` and (if you take B2) `DeployTegridyLPFarming.s.sol` require `TEGRIDY_LP`. This is the TOWELI/WETH pair created by `DeployFinal` in Step 2. After Step 2, grep its output for the pair address and `export TEGRIDY_LP=0x...` before Step 8.

---

## 2. Step-by-step broadcast

Each step below is one `forge script … --broadcast` invocation. Run them in order. Pause after each to capture addresses from the `broadcast/*/run-latest.json` artifact or stdout.

### Step 1 — Sanity check (local, no broadcast)
```bash
forge build --skip test            # must exit 0
forge test --summary               # 66 suites ok, 0 failed
```

### Step 2 — Core protocol (DeployFinal)
Deploys: `TegridyStaking`, `TegridyFactory`, `TegridyRouter`, `TegridyPair` (via factory.createPair), `TegridyRestaking`, `RevenueDistributor`, `ReferralSplitter`, `SwapFeeRouter`, `POLAccumulator`, `PremiumAccess`, `CommunityGrants`, `MemeBountyBoard`.

```bash
forge script script/DeployFinal.s.sol \
  --rpc-url "$ETH_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --slow
```

**After Step 2:**
- Copy `TegridyStaking` addr → `$NEW_STAKING`
- Copy `TegridyPair` addr (logged as `Pair` or read from `TegridyFactory.getPair(TOWELI, WETH)`) → `$TEGRIDY_LP`
- Resolve **Gap A** (sed or env refactor)

### Step 3 — V3 features

> **Note (2026-04-19):** the original `DeployV3Features.s.sol` bundle script was
> deleted when the V1 `TegridyLaunchpad` + `TegridyDrop` source was retired. Use
> per-contract scripts instead — `TegridyDropV2` deploys implicitly via the V2
> factory constructor.

> **R003 callout (2026-04-25):** `TegridyLending` constructor now takes a
> **6th `_twap` arg** for ETH-denominated collateral floor via
> `TegridyTWAP.consult()` (was 5 args after batch 7d). Set `TWAP=…` env var
> from Step 9 output (or pre-deploy a TWAP first). Reference:
> [`.audit_101/remediation/R003.md`](./.audit_101/remediation/R003.md).

Deploys: `TegridyLending`, `TegridyLaunchpadV2` (auto-deploys `TegridyDropV2` template),
`TegridyNFTPool` (template), `TegridyNFTPoolFactory`.

```bash
export TWAP=0x...   # TegridyTWAP address (R003 6th constructor arg)
forge script script/DeployLending.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
forge script script/DeployLaunchpadV2.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
forge script script/DeployNFTPoolFactory.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

### Step 4 — NFT Lending
Standalone, no staking dep.

> **R029 callout (2026-04-25):** `TegridyNFTLending` constructor no longer
> auto-whitelists JBAC / Nakamigos / GNSS. Post-deploy you MUST call the
> `proposeWhitelistCollection` → 24h timelock → `executeWhitelistCollection`
> recipe per collection (see §3 Step 5 below). Reference:
> [`.audit_101/remediation/R029.md`](./.audit_101/remediation/R029.md).

```bash
forge script script/DeployNFTLending.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

### Step 5 — Gauge Controller
Reads updated `TEGRIDY_STAKING`.

```bash
forge script script/DeployGaugeController.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

### Step 6 — Vote Incentives (H-2 commit-reveal)
Reads updated `TEGRIDY_STAKING`.

> **R020 callout (2026-04-25):** `VoteIncentives` constructor now takes a
> **7th `_commitRevealFromGenesis` boolean arg**. Pass `true` to mark epoch 0
> as commit-reveal-active when partnering the Wave-0 `GaugeController`
> (`0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb`); pass `false` only when
> intentionally restoring legacy plaintext voting for an emergency window.
> Also adds `refundUnvotedBribe()` to close Spartan TF-13. Reference:
> [`.audit_101/remediation/R020.md`](./.audit_101/remediation/R020.md).

```bash
forge script script/DeployVoteIncentives.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

### Step 7 — Token URI Reader (optional; points at new staking for NFT metadata)
Already updated by the Step-2 sed sweep above (A1 bundles all four files).

```bash
forge script script/DeployTokenURIReader.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

### Step 8 — LP Farming (C-01 fixed)
Requires both `TEGRIDY_LP` and `TEGRIDY_STAKING` env vars from Step 2.

```bash
export TEGRIDY_LP=0x...        # TOWELI/WETH pair from Step 2
export TEGRIDY_STAKING=0x...   # NEW staking from Step 2 (same $NEW_STAKING used for Gap A sed)
forge script script/DeployTegridyLPFarming.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

**Verify C-01 fix post-deploy:**
```bash
cast call $NEW_LP_FARMING "MAX_BOOST_BPS_CEILING()(uint256)" --rpc-url "$ETH_RPC_URL"
# Expected: 45000
```

### Step 9 — TWAP (if needed)
```bash
forge script script/DeployTWAP.s.sol \
  --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow
```

---

## 3. Post-broadcast wiring (runbook §3)

> **Step 0 prerequisite — Wave-0 multisig `acceptOwnership` STILL OPEN.**
> Before any of the steps below, the Safe `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`
> must call `acceptOwnership()` on the three live Wave-0 contracts:
> LP Farming (`0xa7EF711Be3662B9557634502032F98944eC69ec1`),
> Gauge Controller (`0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb`),
> and NFT Lending (`0x05409880aDFEa888F2c93568B8D88c7b4aAdB139`).
> Tracked in [`docs/WAVE_0_TODO.md`](./docs/WAVE_0_TODO.md) §3.

With ownership transferred to multisig, the multisig must queue and execute:

1. `TegridyStaking.proposeLendingContract(TEGRIDY_LENDING, true)` — wait 48h — `executeLendingContract()`
2. `TegridyStaking.proposeLendingContract(TEGRIDY_NFT_LENDING, true)` — wait 48h — `executeLendingContract()`
3. `TegridyStaking.proposeRestakingContract(TEGRIDY_RESTAKING)` — wait 48h — `executeRestakingContract()`
4. `GaugeController.proposeAddGauge(gaugeA)` + peer gauges — wait 24h — `executeAddGauge()` for each
5. **R029 NFT-collateral whitelist migration** — `TegridyNFTLending` no longer
   auto-whitelists at construction. For each of JBAC / Nakamigos / GNSS:
   ```bash
   # propose
   cast send $TEGRIDY_NFT_LENDING \
     "proposeWhitelistCollection(address)" $JBAC_NFT_ADDRESS \
     --rpc-url "$ETH_RPC_URL" --private-key "$PRIVATE_KEY"
   # …wait 24h timelock…
   cast send $TEGRIDY_NFT_LENDING \
     "executeWhitelistCollection(address)" $JBAC_NFT_ADDRESS \
     --rpc-url "$ETH_RPC_URL" --private-key "$PRIVATE_KEY"
   ```
   Repeat for Nakamigos and GNSS. Verify each via
   `cast call $TEGRIDY_NFT_LENDING "isWhitelisted(address)(bool)" $ADDR`.
6. Fund TOWELI to all reward-paying contracts (LPFarming, TegridyLPFarming, VoteIncentives bribe pool)

---

## 4. Frontend address update

After every broadcast completes, update `frontend/src/lib/constants.ts`. The affected lines (from the current main HEAD):

| Line | Constant | Get new address from |
|---|---|---|
| 5 | `TEGRIDY_STAKING_ADDRESS` | Step 2 output |
| 6 | `TEGRIDY_RESTAKING_ADDRESS` | Step 2 output |
| 9 | `TEGRIDY_FACTORY_ADDRESS` | Step 2 output |
| 10 | `TEGRIDY_ROUTER_ADDRESS` | Step 2 output |
| 11 | `TEGRIDY_LP_ADDRESS` | Step 2 pair addr |
| 14 | `REVENUE_DISTRIBUTOR_ADDRESS` | Step 2 output |
| 15 | `SWAP_FEE_ROUTER_ADDRESS` | Step 2 output |
| 16 | `POL_ACCUMULATOR_ADDRESS` | Step 2 output |
| 19 | `LP_FARMING_ADDRESS` | Step 8 output |
| 22 | `GAUGE_CONTROLLER_ADDRESS` | Step 5 output |
| 25 | `COMMUNITY_GRANTS_ADDRESS` | Step 2 output |
| 26 | `MEME_BOUNTY_BOARD_ADDRESS` | Step 2 output |
| 27 | `REFERRAL_SPLITTER_ADDRESS` | Step 2 output |
| 28 | `PREMIUM_ACCESS_ADDRESS` | Step 2 output |
| 29 | `VOTE_INCENTIVES_ADDRESS` | Step 6 output |
| 32 | `TEGRIDY_LENDING_ADDRESS` | Step 3 output |
| 33 | ~~`TEGRIDY_LAUNCHPAD_ADDRESS`~~ | Removed 2026-04-19 (V1 source deleted). Use `TEGRIDY_LAUNCHPAD_V2_ADDRESS` from Step 3 output. |
| 34 | `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` | Step 3 output |
| 35 | `TEGRIDY_TOKEN_URI_READER_ADDRESS` | Step 7 output |
| 36 | `TEGRIDY_NFT_LENDING_ADDRESS` | Step 4 output |
| 37 | `TEGRIDY_TWAP_ADDRESS` | Step 9 output |
| 45 | `TOWELI_WETH_LP_ADDRESS` | same as line 11 |

Unchanged (keep as-is):
- `TOWELI_ADDRESS` (line 2) — not being redeployed
- `WETH_ADDRESS` (line 41) — canonical
- `TREASURY_ADDRESS` (line 51) — unchanged
- `JBAC_NFT_ADDRESS` (line 54), `JBAY_GOLD_ADDRESS` (line 55) — external

Then:
```bash
cd frontend
npm run wagmi:generate       # regenerates src/generated.ts ABIs against new addrs
npm run build                # sanity check
```

---

## 5. Indexer re-sync

```bash
cd indexer
# edit ponder.config.ts: update every contract address + its startBlock
# (startBlock = the mainnet block where that contract was deployed, visible on Etherscan)
rm -rf .ponder/
npm run codegen              # needs Node 20 LTS if Node 24 throws the Response-state-key error
npm run start                # fresh re-sync, 30–60 min
```

---

## 6. Merkle tree re-issuance (V2 drop allowlists)

**AUDIT NEW-L5:** `TegridyDropV2` now uses a **double-hashed** leaf format
(OpenZeppelin v4.9+ recommendation against second-preimage attacks):

```
leaf = keccak256( bytes.concat( keccak256( abi.encode(address(drop), wallet) ) ) )
```

Notes:
- `abi.encode` (not `abi.encodePacked`) — standard ABI encoding is unambiguous
  for fixed-size types and matches the Solidity verifier exactly.
- Outer `bytes.concat + keccak256` makes leaf-hash and internal-node-hash
  domains disjoint, so an attacker cannot present an intermediate Merkle node
  as if it were a leaf proof.

Historical V1 `TegridyDrop` clones (source deleted 2026-04-19) use the original
single-hash unprefixed `keccak256(msg.sender)` leaf — their existing Merkle
roots stay valid; do not re-issue.

For each V2 drop with an active allowlist:
1. Compute leaves as `keccak256(bytes.concat(keccak256(abi.encode(address(drop), wallet))))`
2. Build the Merkle tree off-chain (OpenZeppelin's `StandardMerkleTree` JS
   library applies the double hash automatically — pass `['address', 'address']`
   for the leaf schema with `[drop, wallet]` values).
3. Call `TegridyDropV2.setMerkleRoot(newRoot)` via multisig.
4. Publish new proofs to the allowlist distribution channel.

If no V2 drops are active yet, skip.

---

## 7. Post-deploy verification checklist

Copy this to a tracking doc and tick as you verify:

### Smart contract invariants (run via cast)
- [ ] `cast call $NEW_LP_FARMING "MAX_BOOST_BPS_CEILING()(uint256)"` → `45000`
- [ ] `cast call $NEW_LENDING "GRACE_PERIOD()(uint256)"` → `3600`
- [ ] `cast call $NEW_LENDING "maxPrincipal()(uint256)"` → `1000000000000000000000` (1000 ether)
- [ ] `cast call $NEW_STAKING "isLendingContract(address)(bool)" $NEW_LENDING` → `false` (pending 48h timelock)
- [ ] Two distinct senders call `TegridyNFTPoolFactory.createPool(...)` with identical args → different pool addresses (CREATE2 salt)
- [ ] `GaugeController.vote(tokenId, gauges, weights)` succeeds on epoch 0 (batch 6 regression)

### Frontend
- [ ] `/` HomePage step-circles render centered (batch 0)
- [ ] `/dashboard` loads without console errors against new addrs
- [ ] `/farm` stake/unstake round-trip works
- [ ] `/swap` connects wallet, Swap/DCA/Limit tabs functional
- [ ] `/nft-finance` renders pool list from the new factory
- [ ] Mobile BottomNav shows Trade/Farm/Dashboard/NFT Finance/More (Community under Lore in dropdown)
- [ ] Block-explorer links resolve to correct chain (batch 1)

### API
- [ ] SIWE sign-in → `/api/auth/me` → JWT cookie round-trip
- [ ] `/api/auth/me` returns 401 for expired tokens
- [ ] `/api/etherscan` rejects `endblock - startblock > 10000`
- [ ] `/api/opensea` rejects URL-encoded paths

### Indexer
- [ ] Re-sync reaches `latestBlock` without errors
- [ ] `restakingClaim`, `bribeClaim`, `proposalVote` tables populate on test events
- [ ] No `0x0`-address rows in any action table

---

## 8. Rollback

- **New contract bug found:** pause via owner multisig (all new contracts include `pause()`). Funds never touch the new contract until wiring + timelock completes, so exposure is minimal.
- **Frontend broken:** revert the `constants.ts` commit; UX restores against the old addresses (old contracts are still on-chain until you explicitly `selfdestruct` or abandon them).
- **Indexer corrupted:** `rm -rf indexer/.ponder/` and re-sync.

---

## 9. Ship sequence summary

```
forge build --skip test        ← confirm clean
forge test                     ← 66 suites, 0 failed
─── Step 2 ─── DeployFinal              → capture NEW_STAKING, TEGRIDY_LP
resolve Gap A (sed or env refactor)
─── Step 3 ─── DeployV3Features
─── Step 4 ─── DeployNFTLending
─── Step 5 ─── DeployGaugeController
─── Step 6 ─── DeployVoteIncentives
─── Step 7 ─── DeployTokenURIReader     (optional)
export TEGRIDY_LP=<pair from Step 2>
export TEGRIDY_STAKING=<staking from Step 2>
─── Step 8 ─── DeployTegridyLPFarming (C-01 fixed)
─── Step 9 ─── DeployTWAP               (optional)
update frontend/src/lib/constants.ts (22 lines)
npm run wagmi:generate
indexer: update ponder.config.ts, rm -rf .ponder/, re-sync
merkle re-issue (if any drops are live)
verify checklist (§7)
```

---

*End of cheat sheet. For severity/change context, cross-reference `DEPLOY_RUNBOOK.md`. For audit-finding-to-contract mapping, `SECURITY_AUDIT_300_AGENT.md`.*
