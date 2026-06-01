# Multisig Migration Runbook

How to hand ownership of every Tegridy Farms contract from a single deployer EOA to a Safe multisig, in one coordinated pass.

This is the single most consequential operational action in the protocol's lifetime. Done correctly, it removes single-key risk forever. Done incorrectly, it can brick admin authority on a $X TVL contract permanently. Read this end-to-end before doing anything on-chain.

**Pre-reads:** [GOVERNANCE.md](./GOVERNANCE.md) (what the owner controls), [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) (what happens when it breaks), [RELAUNCH_RUNBOOK.md](../RELAUNCH_RUNBOOK.md) (deploy ordering).

---

## 0. When to do this

**Before** the protocol holds meaningful user TVL. Every hour delay after launch is single-key risk on real funds.

**After** the post-relaunch smoke tests are all green and the contract set is stable. Migrating mid-redeploy means re-doing the migration on the new addresses.

The sweet spot is the relaunch window itself: deploy → smoke-test → migrate → announce in one continuous session. See [RELAUNCH_RUNBOOK.md § Stage E](../RELAUNCH_RUNBOOK.md).

---

## 1. Why Safe (vs alternatives)

| Option | Verdict |
|---|---|
| **Safe v1.4.1+** | ✅ Default. Industry standard. UI, transaction batching, Safe Transaction Service, hardware-wallet support, audited. |
| Squads | Solana-native; not applicable. |
| MakerDAO ESM-style emergency module | Overkill for current TVL; revisit at $50M+ TVL. |
| OZ Defender Admin | Hosted UI on top of Safe; adds dependency without adding security. |
| Custom multisig | **Hard no.** Every custom multisig in history has been the bug. See [feedback_minimal_surface](../.claude/projects/.../memory) — minimal attack surface mandate. |

Use canonical Safe via the official UI ([app.safe.global](https://app.safe.global)). Don't fork it, don't run a local UI build for "speed."

---

## 2. Threshold + signer composition

### Threshold

| TVL bracket | Recommended threshold |
|---|---|
| < $1M | 2-of-3 |
| $1M – $50M | **3-of-5** ← default for launch |
| > $50M | 4-of-7 |

**Why 3-of-5 for launch:** one signer can be unreachable (vacation, hardware failure, OPSEC compromise) without grinding admin operations to a halt. Two simultaneous compromises is the lower-bound attack — still recoverable via the timelock window on every parameter change.

### Signer composition

Five signers, distinct in three axes: identity (no two from same household / company / chain of trust), geography (timezone-spread), and hardware (no two on the same hardware wallet model — a fleet-wide Ledger firmware vuln must not take all five offline).

| Signer | Role | Hardware | Geography |
|---|---|---|---|
| 1 | Founder | Ledger Nano X | NA-East |
| 2 | Co-founder / lead dev | GridPlus Lattice1 | EU |
| 3 | External security advisor | Trezor Model T | NA-West |
| 4 | Community-elected | Ledger Stax | APAC |
| 5 | Cold backup (only signs for rotation) | Air-gapped Keystone | Offline geo |

Signer addresses **must be publicly attributed** in [GOVERNANCE.md § Multisig](./GOVERNANCE.md#multisig) within 24h of migration. Hidden signers are equivalent to no multisig for trust purposes.

### Recovery plan

- Each signer keeps an encrypted backup of their seed phrase (passphrase-protected, geographically separated from the device).
- Cold backup signer (#5) maintains an air-gapped device that only signs `addOwnerWithThreshold` / `removeOwner` transactions — not parameter changes.
- Lose-2-signers scenario: 3-of-3 surviving signers can still execute. Replace lost signers via Safe's owner-management flow.
- Lose-3-signers scenario: multisig is bricked. Use the cold backup signer + 2 surviving + emergency social recovery (Safe Recovery Module if installed, otherwise public attestation + community vote).

---

## 3. Safe deployment

### 3.1 Deploy

1. Navigate to [app.safe.global](https://app.safe.global) → Create new Safe.
2. Select **Ethereum mainnet**.
3. Name: `Tegridy Farms Treasury`.
4. Add 5 signer addresses (paste each carefully; double-check via Etherscan).
5. Set threshold to **3**.
6. Pay deployment gas from a *fresh* EOA (not the protocol deployer EOA — separation of concerns).
7. **Record the Safe address.** It will be required everywhere downstream.

### 3.2 Verify

Before transferring anything to this Safe:

```bash
SAFE=0x...                    # the just-deployed Safe address
cast call $SAFE "getOwners()(address[])" --rpc-url $RPC
cast call $SAFE "getThreshold()(uint256)" --rpc-url $RPC
cast call $SAFE "VERSION()(string)" --rpc-url $RPC  # expect "1.4.1" or later
```

All five owners present + threshold = 3 + version ≥ 1.4.1. If any of these are off, **do not proceed.**

### 3.3 Fund

Send 0.1 ETH from a non-deployer EOA to the Safe address. Confirms the Safe can receive ETH and gives it gas for batch operations.

### 3.4 Smoke-test

Execute a no-op self-call: Safe → `setGuard(address(0))` (defaults already, no state change). Confirms:
- All signers can actually log into the Safe UI
- Hardware wallets sign correctly
- Threshold execution works end-to-end

If any signer fails this step, fix before proceeding. **Do not transfer ownership to an untested Safe.**

---

## 4. Pre-migration inventory

Run this inventory before touching `transferOwnership`. Every contract listed must be migrated; missing one strands its admin surface on the deployer EOA forever.

### 4.1 Generate the live list

```bash
# Expected output: every contract address from frontend/src/lib/constants.ts
# Cross-reference against on-chain to catch any drift.

cd "C:/Users/jimbo/OneDrive/Desktop/tegriddy farms"
grep -E "^export const [A-Z_]+_ADDRESS" frontend/src/lib/constants.ts \
  | grep -v "0x0000000000000000000000000000000000000000" \
  > /tmp/contract-inventory.txt

cat /tmp/contract-inventory.txt
```

### 4.2 Confirm owner() for each

```bash
# Replace ADDR with each address. Expect the same deployer EOA for all.
cast call $ADDR "owner()(address)" --rpc-url $RPC
```

If any contract returns a different owner (e.g. an old multisig, a CREATE2 proxy, zero), flag it. Special cases:

- **TegridyFeeHook** (`0xB6cf…0044`): deployed via Arachnid CREATE2 proxy. Owner is the proxy (`0x4e59b44…`), not the deployer. **This contract requires a constructor patch + redeploy before it can be migrated.** Track in [NEXT_SESSION.md § Wave-0 redeploys](../NEXT_SESSION.md).
- **Admin sister contracts** (`TegridyStakingAdmin`, `SwapFeeRouterAdmin`): own themselves via timelocked propose/execute. Migration is via their `proposeAdminReplacement(multisig)` → 7-day wait → `executeAdminReplacement()` flow, not direct `transferOwnership`. See [§7](#7-admin-sister-contracts).

### 4.3 Canonical owner-controlled list

As of writing, these contracts require migration. **Update this table before each migration pass** — drift between this file and reality is the failure mode.

| # | Contract | Constants.ts symbol | Migration path |
|---|---|---|---|
| 1 | TegridyStaking | `TEGRIDY_STAKING_ADDRESS` | Direct `transferOwnership` |
| 2 | TegridyRestaking | `TEGRIDY_RESTAKING_ADDRESS` | Direct `transferOwnership` |
| 3 | TegridyFactory | `TEGRIDY_FACTORY_ADDRESS` | Direct `transferOwnership` |
| 4 | TegridyRouter | `TEGRIDY_ROUTER_ADDRESS` | Direct `transferOwnership` |
| 5 | SwapFeeRouter | `SWAP_FEE_ROUTER_ADDRESS` | Direct `transferOwnership` |
| 6 | RevenueDistributor | `REVENUE_DISTRIBUTOR_ADDRESS` | Direct `transferOwnership` |
| 7 | POLAccumulator | `POL_ACCUMULATOR_ADDRESS` | Direct `transferOwnership` |
| 8 | TegridyLPFarming | `LP_FARMING_ADDRESS` | Direct `transferOwnership` |
| 9 | GaugeController | `GAUGE_CONTROLLER_ADDRESS` | Direct `transferOwnership` |
| 10 | CommunityGrants | `COMMUNITY_GRANTS_ADDRESS` | Direct `transferOwnership` |
| 11 | MemeBountyBoard | `MEME_BOUNTY_BOARD_ADDRESS` | Direct `transferOwnership` |
| 12 | ReferralSplitter | `REFERRAL_SPLITTER_ADDRESS` | Direct `transferOwnership` |
| 13 | PremiumAccess | `PREMIUM_ACCESS_ADDRESS` | Direct `transferOwnership` |
| 14 | VoteIncentives | `VOTE_INCENTIVES_ADDRESS` | Direct `transferOwnership` |
| 15 | TegridyLending | `TEGRIDY_LENDING_ADDRESS` | Direct `transferOwnership` |
| 16 | TegridyNFTLending | `TEGRIDY_NFT_LENDING_ADDRESS` | Direct `transferOwnership` |
| 17 | TegridyNFTPoolFactory | `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` | Direct `transferOwnership` |
| 18 | TegridyTokenURIReader | `TEGRIDY_TOKEN_URI_READER_ADDRESS` | Direct `transferOwnership` |
| 19 | TegridyTWAP | `TEGRIDY_TWAP_ADDRESS` | Direct `transferOwnership` |
| 20 | TegridyLaunchpadV2 | `TEGRIDY_LAUNCHPAD_V2_ADDRESS` | Direct (after V2 deploy) |
| 21 | TegridyStakingAdmin | `TEGRIDY_STAKING_ADMIN_ADDRESS` | See [§7](#7-admin-sister-contracts) |
| 22 | SwapFeeRouterAdmin | `SWAP_FEE_ROUTER_ADMIN_ADDRESS` | See [§7](#7-admin-sister-contracts) |
| 23 | TegridyFeeHook | `TEGRIDY_FEE_HOOK_ADDRESS` | Blocked — see [§4.2](#42-confirm-owner-for-each) |

**Excluded by design:**
- TOWELI token (`TOWELI_ADDRESS`) — no owner; immutable post-deploy.
- TegridyLP (`TEGRIDY_LP_ADDRESS`) — UniswapV2-style pair; permissionless.
- V1 contracts (TegridyDrop, TegridyLaunchpad V1) — source deleted; clones remain on-chain but out of scope.

---

## 5. The migration script

Shipped at [`contracts/script/TransferOwnershipToMultisig.s.sol`](../contracts/script/TransferOwnershipToMultisig.s.sol). Unit-tested at [`contracts/test/TransferOwnershipToMultisig.t.sol`](../contracts/test/TransferOwnershipToMultisig.t.sol) (9 tests, covers happy path, MULTISIG validation, owner-mismatch, factory-mismatch, partial-inventory, idempotent replay, length-mismatch).

### 5.1 Why a script (not Safe Tx Builder)

The deployer EOA is the *outgoing* owner, so it must initiate `transferOwnership(multisig)` on each contract. The Safe is the *incoming* owner and signs `acceptOwnership()`. These are two separate sides; the script handles only the outgoing side.

A single `forge script` ensures atomic ordering and a single broadcast cost. Doing it tx-by-tx via cast risks fat-fingering an address mid-pass.

### 5.2 What the script does

The implementation has three layers:

1. **`run()` — production entrypoint.** Reads every contract address from env vars (`MULTISIG`, `TEGRIDY_STAKING`, `SWAP_FEE_ROUTER`, etc.), wraps the migration in `vm.startBroadcast()` so each `transferOwnership` is signed by the `--private-key` deployer.
2. **`_runPreChecks(sender)` — fail-fast guards.**
   - `MULTISIG != address(0)` and `MULTISIG.code.length > 0` (catches the "pasted a hardware-wallet address" mistake).
   - For each ownable contract: `owner() == sender` (catches typo'd env vars that point at an unrelated contract that happens to expose `transferOwnership`).
   - For the factory: `feeToSetter() == sender` (same guard, separate auth model).
3. **`_executeTransfers()` — the actual writes.** Loops the inventory, calls `transferOwnership(multisig)` per ownable, and `proposeFeeToSetter(multisig)` on the factory. Logs each transition to console.

The inventory is built from env vars in `_collect()`. Any env var resolving to `address(0)` is silently skipped — so the same script works for MVP-only deploys and the full 22-contract set without code edits.

`runForTest(sender, multisig, ownables, labels, factory)` is a unit-test entrypoint that takes the inventory as explicit args (avoids env-var pollution between tests) and uses `vm.startPrank(sender)` internally so the prank propagates into the mock contracts' `transferOwnership` calls. Tests cover happy path, MULTISIG validation, owner-mismatch, factory-mismatch, partial-inventory, idempotent replay, and array length-mismatch.

### 5.3 Dry-run first

```bash
forge script script/TransferOwnershipToMultisig.s.sol \
  --rpc-url $RPC \
  --sender $DEPLOYER \
  -vvv
# NO --broadcast flag yet. Just simulate.
```

Read every line of the simulation output. Confirm:
- 22 (or whatever the inventory size is) successful `transferOwnership` calls.
- Each `newOwner` is the Safe address.
- No reverts.
- Total gas estimate < 0.05 ETH at current basefee.

### 5.4 Broadcast

```bash
forge script script/TransferOwnershipToMultisig.s.sol \
  --rpc-url $RPC \
  --private-key $DEPLOYER_KEY \
  --broadcast \
  --verify
```

Expected outcome: 22 transactions, each emitting `OwnershipTransferStarted(deployer, multisig)`. **Pending state, not accepted yet** — that's the next step.

---

## 6. Multisig accepts ownership

OZ Ownable2Step requires the new owner to actively claim ownership via `acceptOwnership()`. Until accepted, the deployer EOA retains all admin authority. **You have 14 days** to accept before the pending transfer auto-expires (custom expiry in [OwnableNoRenounce.sol:137-150](../contracts/src/base/OwnableNoRenounce.sol#L137-L150)) — leave a comfortable margin; aim for same-session acceptance.

### 6.1 Build the batch in Safe Tx Builder

1. Open Safe → Apps → **Transaction Builder**.
2. For each contract from [§4.3](#43-canonical-owner-controlled-list):
   - Contract address: `[contract]`
   - ABI: paste from `frontend/src/lib/wagmi-generated.ts` or look up on Etherscan
   - Method: `acceptOwnership`
   - No arguments.
3. Save the batch as a single JSON file: `scripts/safe-batches/accept-ownership-2026-MM-DD.json`. Commit to the repo for audit trail.

### 6.2 Sign + execute

- 3 signers approve the batch in the Safe UI.
- Last signer executes. Single multicall transaction; one gas payment.
- Watch for `OwnershipTransferred(deployer, multisig)` events on every contract.

### 6.3 Verify

```bash
# For every contract in the inventory:
for addr in $(cat /tmp/contract-inventory.txt | awk -F"'" '{print $2}'); do
  current=$(cast call $addr "owner()(address)" --rpc-url $RPC)
  expected=$SAFE
  if [ "$(echo $current | tr A-Z a-z)" != "$(echo $expected | tr A-Z a-z)" ]; then
    echo "MISMATCH on $addr: owner=$current expected=$expected"
  else
    echo "OK $addr"
  fi
done
```

**Zero MISMATCH lines.** Any mismatch means that contract was missed in the batch and must be re-accepted via a follow-up Safe tx within the 14-day window.

---

## 7. Admin sister contracts

`TegridyStakingAdmin` and `SwapFeeRouterAdmin` are the EIP-170 split sister contracts that hold the timelocked parameter-change surfaces for their main contracts. They are NOT migrated via `transferOwnership` — they're authorised via the main contract's `setStakingAdmin(addr)` / `setSwapFeeRouterAdmin(addr)` calls, each of which is itself timelocked.

### 7.1 Current state

At time of writing, both addresses in [constants.ts:15-16](../frontend/src/lib/constants.ts#L15-L16) are `0x000...` — the sister contracts have not yet been deployed.

### 7.2 Required sequence (per sister)

1. **Deploy** the admin contract pointing at the main contract (`new TegridyStakingAdmin(stakingAddr)`).
2. **Main contract proposes** the new admin: `staking.proposeAdminReplacement(newAdmin)`.
3. **Wait** 7 days (per `ADMIN_REPLACEMENT_TIMELOCK` constant).
4. **Main contract executes**: `staking.executeAdminReplacement()`. Now the sister admin is authoritative for all parameter changes on the main contract.
5. **Transfer ownership of the sister** to the multisig via the standard [§5](#5-the-migration-script) flow.
6. **Multisig accepts** the sister contract's ownership in the [§6](#6-multisig-accepts-ownership) batch.

This is a 7-day-minimum critical path. **Start it before the main migration**, not after.

### 7.3 Rollback

If the sister deployment is buggy, the main contract's `proposeAdminReplacement` can be cancelled via `cancelAdminReplacement` before the 7-day timelock executes. Once `executeAdminReplacement` fires, rolling back requires a fresh `proposeAdminReplacement(oldAdmin)` + another 7-day wait.

---

## 8. Post-migration verification

Beyond [§6.3](#63-verify), confirm these end-to-end:

### 8.1 Negative test — deployer can no longer admin

From the deployer EOA, attempt a parameter change. Expect `OwnableUnauthorizedAccount` revert.

```bash
# Should revert
cast send $TEGRIDY_STAKING "pause()" --rpc-url $RPC --private-key $DEPLOYER_KEY
```

### 8.2 Positive test — multisig can admin

Build a tiny no-op admin tx via Safe (e.g. `setPauseGuardian(currentGuardian)` — re-sets the existing guardian, no-op semantically but exercises the auth path).

3 signers approve, last executes. Watch for the corresponding event. Confirms the multisig is functional as the authoritative owner.

### 8.3 Update frontend + docs

- [GOVERNANCE.md](./GOVERNANCE.md) § Multisig — add Safe address + signer table + tx hash linking the migration.
- [README.md](../README.md) — replace any "single-key admin" copy with multisig framing.
- Frontend AdminPage gating — the page already does `owner() == connectedAddress` checks; nothing to change, but verify it still loads correctly when connected to one of the signer wallets.

### 8.4 Public announcement

Once verification is green, post the announcement. Template:

> Tegridy Farms admin has migrated to a 3-of-5 multisig Safe at [0x…]. Signers: [list with handles/orgs]. Transaction batch: [Etherscan link]. The deployer EOA at [0x…] no longer has admin authority on any protocol contract; we've verified this on-chain at [block #]. From now on, every parameter change requires 3 signer approvals + the existing timelock window.

---

## 9. Failure modes (what to do if…)

### …a signer's hardware wallet bricks mid-migration

The migration only requires the *deployer EOA* to sign the outgoing transferOwnership calls — multisig signers aren't on the critical path until acceptOwnership in [§6](#6-multisig-accepts-ownership). If a signer is down, you have 14 days. Replace via Safe owner-management before the window closes.

### …deployer EOA is compromised mid-migration

Stop. Do not broadcast any further txs from that key.

- If `transferOwnership` was already broadcast on some contracts: those contracts are in `pendingOwner = multisig` state. Attacker can't cancel because [`cancelOwnershipTransfer`](../contracts/src/base/OwnableNoRenounce.sol#L161) only resets to current owner (still the compromised EOA). Multisig should immediately `acceptOwnership` on those contracts.
- For contracts not yet migrated: the attacker has full admin authority. Pause everything pauseable, multisig race against the attacker on `transferOwnership(attacker)`. Worst case: attacker wins on a contract; multisig governance-attack-recovers via paused frontend + community comms (see [INCIDENT_RESPONSE.md § 5](./INCIDENT_RESPONSE.md#5-first-15-minutes)).

### …the Safe was deployed with the wrong threshold or signers

Deploy a new Safe. Don't try to fix the old one — incoming Safe tx to modify signers takes signer-approvals from the broken signer set, which is the problem you're trying to escape.

If `transferOwnership` was already broadcast to the broken Safe: it must `acceptOwnership` first, then `transferOwnership(newSafe)`, then the new Safe `acceptOwnership`. Two 14-day windows back-to-back; coordinate.

### …`acceptOwnership` is forgotten and the 14-day window expires

The pending owner slot zeros automatically (per `ownershipTransferExpiresAt` logic). Deployer EOA retains ownership. Just re-broadcast the migration script. Annoying but recoverable — no permanent damage.

---

## 10. Post-migration checklist

- [ ] [§4](#4-pre-migration-inventory): Inventory generated + reviewed
- [ ] [§3](#3-safe-deployment): Safe deployed + smoke-tested
- [ ] [§5](#5-the-migration-script): TransferOwnership script broadcast, all 22 contracts in `pendingOwner = multisig` state
- [ ] [§6](#6-multisig-accepts-ownership): Multisig `acceptOwnership` batch executed; zero MISMATCH in [§6.3](#63-verify)
- [ ] [§7](#7-admin-sister-contracts): Both admin sister contracts deployed, proposed, executed (7-day wait), and themselves migrated
- [ ] [§8.1](#81-negative-test--deployer-can-no-longer-admin): Negative test passes (deployer cannot admin)
- [ ] [§8.2](#82-positive-test--multisig-can-admin): Positive test passes (multisig can admin)
- [ ] [§8.3](#83-update-frontend--docs): Docs updated with Safe address + signers
- [ ] [§8.4](#84-public-announcement): Public announcement posted
- [ ] [INCIDENT_RESPONSE.md § 9](./INCIDENT_RESPONSE.md#9-contact-tree) Contact Tree updated with signer Signal/Telegram handles
- [ ] Deployer EOA key destroyed (cut card, wiped device, signed-attestation). Keys that "could" sign are not retired keys.

---

*Last updated: 2026-05-26. Update this file whenever the contract inventory changes, the threshold changes, or a signer is rotated.*
