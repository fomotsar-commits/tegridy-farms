# URGENT — Close the 0xA360 acceptOwnership windows (deadline 2026-07-30 ~04:39 UTC)

**Status:** ready to send. Every command below was verified against mainnet on
**2026-07-19 04:17 UTC** (block 25,564,314) — state read live, calldata generated,
and each call **simulated from the deployer via `eth_call` (all 9 returned OK)**.
Nothing here has been signed or broadcast; that is yours to do.

Companion docs: [`SAFE_REHOME_RUNBOOK.md`](SAFE_REHOME_RUNBOOK.md) (the full rebuild +
re-home sequence this unblocks), `GOLIVE_HANDOFF.md`.

---

## Why this is urgent

The 2026-07-16 gated-feature batch left **9 contracts** with a live 2-step ownership
transfer pending to **`0xA360…b7F8`** — the Safe the red-team flagged
(`{0x28d7…, 0xE9B7…}` is a winning quorum, and 2 of 3 signers are EIP-7702-delegated
to the *same* smart wallet). While the window is open, **a compromised `0xA360`
quorum can call `acceptOwnership()` and take these contracts.** They are
frontend-gated and hold ~no funds, so the loss would be *operational* — recovering
them would then require operating `0xA360` itself.

The prior plan was to let the window lapse passively. **Cancelling is strictly
better:** it closes the window *now*, needs **no rebuilt Safe**, costs ~5 cents, and
leaves the owner unchanged.

## Verified on-chain state (2026-07-19 04:17 UTC)

| Contract | Address | owner | pendingOwner | Window expires (UTC) |
|---|---|---|---|---|
| GaugeController | `0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054` | `0x1489…` | `0xA360…` | Jul 30 04:39:23 |
| VoteIncentives | `0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF` | `0x1489…` | `0xA360…` | Jul 30 04:41:11 |
| VoteIncentivesAdmin | `0xf87Ec231BA7FA3975619309bc16C698B2ea3B300` | `0x1489…` | `0xA360…` | Jul 30 04:41:59 |
| PremiumAccess | `0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5` | `0x1489…` | `0xA360…` | Jul 30 04:43:47 |
| TegridyNFTLending | `0x89BeB6cc0255B7465c01aA38a6f937efd345f14F` | `0x1489…` | `0xA360…` | Jul 30 05:02:47 |
| TegridyNFTLendingAdmin | `0x693787831e9C36A98aFEDAd39f8728491F580a9C` | `0x1489…` | `0xA360…` | Jul 30 05:02:59 |
| MemeBountyBoard | `0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890` | `0x1489…` | `0xA360…` | Jul 30 05:05:23 |
| CommunityGrants | `0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471` | `0x1489…` | `0xA360…` | Jul 30 05:06:59 |
| TegridyLaunchpadV2 | `0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7` | `0x1489…` | `0xA360…` | Jul 30 05:08:11 |

**Not in this list — handled separately:**
- **NFTPoolFactory `0xbB8E…6F5B`** — `owner = 0xA360` **directly** (constructor-set, no
  2-step), `pendingOwner = 0x0`. There is no window to cancel. Re-home it during the
  Safe rebuild via `0xA360.transferOwnership(newSafe)` (requires operating `0xA360` once).
- **TegridyDropV2 `0xA35e…e872`** — LaunchpadV2's clone template; no owner.
- Wave-1 MVP + LPFarming windows already expired ~Jun 20-22 — nothing to do.

*(This resolves the earlier "10 two-step contracts" note: it is **9** two-step +
the ctor-direct factory.)*

## What the call actually does

`OwnableNoRenounce.cancelOwnershipTransfer(string reason)` (src/base/OwnableNoRenounce.sol:205, `onlyOwner`):

```solidity
address prev = pendingOwner();
if (prev == address(0)) revert NoPendingOwnershipTransfer();
_transferOwnership(owner());          // same owner -> clears pendingOwner + zeroes expiry
emit OwnershipTransferCancelled(prev, reason);
```

- **Owner does NOT change** — stays the clean deployer `0x1489…456E`.
- `pendingOwner` → `0x0`, `ownershipTransferExpiresAt` → `0`.
- Callable by the **deployer EOA only** (it is the current owner) — **no Safe needed.**
- Idempotency: running it twice reverts `NoPendingOwnershipTransfer()`. Harmless.

## Pre-flight verification already done

| Check | Result |
|---|---|
| Selector `0x97130667` present in **deployed** bytecode | ✅ all 9 |
| `eth_call` simulation from deployer `0x1489…` | ✅ all 9 returned `0x` (success) |
| Gas estimate | ~39.8k–40.8k each, **361,696 total** |
| Cost @ 0.0486 gwei | **≈ 0.0000176 ETH (~$0.05)** |
| Deployer balance | 0.01777 ETH — ample |

## Run it

```bash
export RPC=https://ethereum-rpc.publicnode.com
export REASON="Safe rebuild pending - re-home to clean multisig"
# Signer: whichever you used for the 2026-07-16 deploy.
export SIGNER="--account deployer"     # or: --ledger
```

Send all nine (public mempool is fine — these are not sandwichable):

```bash
for A in \
  0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054 \
  0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF \
  0xf87Ec231BA7FA3975619309bc16C698B2ea3B300 \
  0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5 \
  0x89BeB6cc0255B7465c01aA38a6f937efd345f14F \
  0x693787831e9C36A98aFEDAd39f8728491F580a9C \
  0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890 \
  0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471 \
  0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7 ; do
  echo "== $A"
  cast send "$A" "cancelOwnershipTransfer(string)" "$REASON" \
    $SIGNER --rpc-url $RPC
done
```

If you prefer raw calldata (identical for all 9 — it encodes only the function +
reason, not the target):

```
to:    <each address above>
value: 0
data:  0x9713066700000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000030536166652072656275696c642070656e64696e67202d2072652d686f6d6520746f20636c65616e206d756c746973696700000000000000000000000000000000
```

## Verify afterwards

Expect `pendingOwner = 0x0…0`, `expiry = 0`, `owner` unchanged (`0x1489…456E`):

```bash
for A in <same nine addresses> ; do
  echo "$A owner=$(cast call $A 'owner()(address)' --rpc-url $RPC)" \
       "pending=$(cast call $A 'pendingOwner()(address)' --rpc-url $RPC)" \
       "expiry=$(cast call $A 'ownershipTransferExpiresAt()(uint256)' --rpc-url $RPC)"
done
```

## What this does NOT do

- It does **not** re-home ownership. After the Safe rebuild you still run
  `transferOwnership(newSafe)` on all 9 (fresh 14-day clock) then `acceptOwnership()`
  from the new Safe — see `SAFE_REHOME_RUNBOOK.md`. That step was required anyway:
  the original handoff clock **already expired Jun 21**, so the handoff has to be
  re-initiated regardless.
- It does **not** touch NFTPoolFactory (already `0xA360`-owned; needs the rebuild).
- It does **not** change the frontend gating. Keep fund-touching features gated in
  `frontend/src/lib/constants.ts` until ownership is re-homed to a clean Safe.
