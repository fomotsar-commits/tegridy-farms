# Cardano pools: what the audit covers

> The one to-do list is [docs/TODO_OPERATOR.md](TODO_OPERATOR.md). This file is the brief to hand
> an auditor for the venue's own Cardano pools. The plan behind it is `docs/CARDANO_PLAN.md`
> (Part 2), on the swap's pull request #986 until that merges.

Written 2026-10-24. Nothing here is deployed, on any network.

## In one paragraph

The venue's Cardano pools are a copy of Minswap V2 with one constant changed: the lowest fee share
a pool may give its fee taker, lowered from 1666 to 1333 parts in 10,000 of the trade fee, so the
venue can take less than Minswap does (the owner's ruling, 2026-10-24). CertiK's finding MIN-01
(acknowledged by Minswap, never fixed) is that Minswap's admin can change batchers, fee takers and
a pool's stake key instantly. We close it without touching Minswap's code: every admin role in
Minswap's GlobalSetting is held by one new validator of ours, the **role timelock**, which lets a
change through only after it was announced on chain 48 hours earlier, and only with both owner
keys. The audit covers the one-constant patch and the pool validator it changes, the role
timelock, the deploy parameters, and (when it exists) the batcher. Every other Minswap validator
is out of scope: we prove its bytes are the ones on mainnet.

## 1. Minswap V2: copied, one constant patched, the rest proven

| | |
|---|---|
| Source | [minswap/minswap-dex-v2](https://github.com/minswap/minswap-dex-v2) @ `c3293ad435792ba502f5a2b1691c6736e5f167e6` (2024-07-10). Validators unchanged since CertiK's re-audit commit `d299bd1`. |
| Our copy | `cardano/minswap-dex-v2/`: 24 upstream files, each pinned by hash (`cardano/guards/upstream/minswap-dex-v2.sha256`), plus the reviewed patch (`minswap-dex-v2.diff`, its own hash pinned). `node cardano/guards/provenance.mjs` fails on any other edit, an added or missing file, or a changed patch. |
| Compiler | Aiken `v1.0.24-alpha+982eff4`, the version in Minswap's `plutus.json`; stdlib 1.7.0 at commit `97cd61345bcc8925c521b30d0f354859eb0148cd`. CI checks the release tarball's sha256. |
| Proof | `node cardano/guards/prove-build.mjs`: (a) our copy with the patch undone builds to Minswap's `plutus.json` exactly, and with Minswap's own mainnet parameters, applied as Minswap's `src/script.ts` does, to the six deployed scripts byte for byte (`--chain` also reads each from its mainnet reference UTxO, through Koios); (b) our copy as it stands changes exactly one validator's code, below. |
| Prior audits | CertiK (audit and re-audit) and Anastasia Labs, in `audit-report/` at the pin (not copied here). |

Minswap's six mainnet scripts, from our copy with the patch undone (2026-10-24; our build,
Minswap's `deployed/mainnet/script.json` and the reference script on mainnet all agree):

| Script | Hash | Mainnet reference UTxO |
|---|---|---|
| Authen policy (LP tokens, pool and GlobalSetting NFTs) | `f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c` | `dbc1498500a6e79baa0f34d10de55cdb4289ca6c722bd70e1e1b78a858f136b9#0` |
| Pool | `ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b` | `2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea#0` |
| Pool batching | `1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a` | `d46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17#0` |
| Order | `c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c` | `cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776#0` |
| Factory | `7bc5fbd41a95f561be84369631e0e35895efb0b73e0a7480bb9ed730` | `59c7fa5c30cbab4e6d38f65e15d1adef71495321365588506ad089d237b602e0#0` |
| Expired-order cancel | `c8b0cc61374d409ff9c8512317003e7196a3e4d48553398c656cc124` | `ef3acc7dfc5a98bffe8f4d4400e65a9ade5a1316b2fcb7145c3b83dba38a66f5#0` |

## 2. In scope: the one patch to Minswap's code

```
=== lib/amm_dex_v2/utils.ak ===
61c61
< pub const min_fee_sharing_numerator = 1666
---
> pub const min_fee_sharing_numerator = 1333
```

The comment above it still says "Min 16.66%", as Minswap wrote it: the patch is that one line.
The same patch is in the role timelock's copy of Minswap's library, so its tests run the checks we
deploy.

**What it changes.** The constant is read in one place: `pool_validation.validate_update_pool_parameters`,
on the `UpdatePoolFee` action, as the lower bound of a pool's new fee share. Only
`pool_validator.validate_pool` calls that, so it is the only validator whose code changes: 2 bytes
of its 3,931 (offsets 456 and 457, the compiled constant), hash `6df8eb96…` to `5fcf4b93…`
unparameterised. The other nine validators in the blueprint keep Minswap's bytes, and the proof
fails if any of them changes. With Minswap's own mainnet parameters, the authen policy and the
expired-order cancel keep their mainnet hashes; the pool's hash changes (`ea07b733…` to
`ba2d6e2c…`), and so do the three whose parameters name it: pool batching (`1eae96ba…` to
`224830db…`), order (`c3e28c36…` to `21c19e8d…`) and factory (`7bc5fbd4…` to `cdbe4231…`). Our
deploy has its own seed and stake key, so every hash differs again there, from the same code.

**What to check.** Minswap's fee-share arithmetic (`math.ak`, `amount * trading_fee * share /
denominator²`) takes the share as a plain fraction and assumes no floor; the floor was Minswap's
policy, not a safety bound. Is 1333 safe in every batching path, rounding included? The factory
still requires a new pool's share to be off, so nothing else reads the bound.

## 3. In scope: the role timelock (new code)

Files: `cardano/role-timelock/validators/role_timelock.ak` (the entry points),
`lib/role_timelock/lock.ak` (all logic, about 250 lines), `lib/role_timelock/types.ak`, tests in
`lib/role_timelock/lock_test.ak`. `lib/amm_dex_v2/` there is Minswap's library with the same
one-line patch, hash-pinned, compiled in for its types and constants and called by the tests. The
lock does not read the patched constant, so its own bytes are the same either way. Plutus V2, the
same compiler as Minswap. Unapplied script: 5,845 bytes, hash `98ffcad7e16e08ccb989655355f8696b9602f0d31b8fc697f1bf6665`; one parameter.

### Why it has to inspect the whole transaction

Minswap checks a `PAMSpendScript(h)` role by looking for **any** transaction input whose payment
credential is `h` (`utils.authorize_pool_license`). So the moment the lock's UTxO is spent, every
role the lock holds is present at once, whatever the lock's redeemer says. Each path of the lock
therefore states which Minswap UTxO the transaction may move, and what it must leave there. The
"moved" UTxOs are the inputs holding a pool NFT (`MSP`) or the GlobalSetting NFT (`MSGS`) of our
authen policy; every role-gated Minswap action spends one of those.

### Roles

| GlobalSetting field | Held by |
|---|---|
| `admin`, `pool_fee_updater`, `pool_stake_key_updater`, `pool_dynamic_fee_updater`, `fee_sharing_taker` | `PAMSpendScript(<role timelock hash>)` |
| `batchers` | hot keys (or scripts) the owner chooses. Batchers cannot change any parameter. Changing the list is an admin change, so it waits 48 hours. |

### The rules

The lock is one UTxO at the lock's own enterprise address, holding the lock token (policy = the
lock's own hash, name `role-timelock`) and nothing else but ADA, with inline datum
`State { announced: List<Announcement> }`. **Every path needs both owner keys** (the two must
differ).

| Path | What it allows |
|---|---|
| Mint (once) | The seed UTxO is spent; exactly one lock token is minted; it goes into the lock with nothing announced. No later mint or burn is possible (the seed is gone). |
| `Announce` | Adds one announcement whose `ready_at` is at least the transaction's upper time bound + 48 h. Moves no pool or GlobalSetting. At most 16 waiting. |
| `Cancel { index }` | Removes one announcement. Moves no pool or GlobalSetting. |
| `Execute { index }` | In the window `[ready_at, ready_at + 14 days]` (the lower bound must be at or after `ready_at`, the upper at or before the end), removes the announcement and makes exactly that change. `SetGlobalSetting(s)`: one UTxO moved, and the GlobalSetting output's inline datum equals `s` as Data. `SetPool {...}`: one pool moved, its value unchanged (so no fee withdrawal rides along), and its new datum's pair, both base fees, fee share and dynamic-fee flag, and its address's stake credential, all equal the announcement. Minswap itself pins the pool's other fields. |
| `WithdrawFeeSharing` | One pool moved, its address and datum unchanged, the lock unchanged, and the outputs to the treasury hold at least everything that left the pool, asset by asset. No wait: this changes nothing. |

A UTxO sent to the lock's address without the lock token can never be spent, so a forged
"announced long ago" datum does nothing. The 48 hours and the 14-day window are Compound's
Timelock (`delay`, `GRACE_PERIOD`), the most used timelock in DeFi; we found no audited Cardano
validator for "announce, wait, execute" to copy (Liqwid's Agora has a delay inside a full
token-voting DAO, in Plutarch; SundaeSwap's treasury contracts have multisig permissions but no
delay), so this pattern is our own code and the reason for this audit.

### What it does not protect against

- **Both keys compromised.** The attacker announces, and 48 hours later makes the change. What
  the lock buys is the notice: LPs and traders can see the announcement on chain and leave.
- **A bad batcher.** Batchers are not held by the lock. Minswap's order script pays every trader at
  least their minimum, so a batcher cannot steal, but it can order trades within the slippage
  traders set.
- **Anything at deploy.** The first GlobalSetting is written by `DexInitialization`, which checks no
  admin. The deploy transaction must name the lock in all five roles (section 4).

### Tests

90 tests in `lock_test.ak`, run by `aiken check` in CI (with Minswap's own 31 library tests). Each
path passes once, then each way to act early (one millisecond before `ready_at`, one past the
window, an announcement one millisecond short of 48 hours, no time bound at all), with one key,
with a stranger's key, with a change other than the one announced (each pool field on its own,
the GlobalSetting's fee taker, the stake key), with a second Minswap UTxO moved, with the lock
token sent away, and with a forged or copied lock is refused. Where Minswap's own checks would let
the same transaction through, a `minswap_` test runs them (the real `pool_validation` and `utils`
functions) to show the lock is what stops it. The venue's 1333 share passes Minswap's patched check
and 1332 is refused; on Minswap's unpatched floor, the three tests that set 1333 fail. A mutation
pass (2026-10-24) broke each of the 48 checks in `lock.ak` one at a time: every mutant was refused
by at least one test.

### Questions we have for the auditor

1. Is Aiken v1.0.24-alpha safe for new code? We chose it so one compiler builds everything, the
   one whose output has run Minswap V2 on mainnet since 2024. A newer compiler would mean a second
   toolchain.
2. Validity-range ends: the lock ignores whether an end is inclusive (one millisecond). Fine?
3. Is 16 waiting announcements the right cap, given each new pool needs one (section 4)?
4. Comparing the GlobalSetting datum as Data, and the pool datum by decoding Minswap's
   `PoolDatum`: any encoding that passes Minswap's own `expect` but not ours, or the reverse?
5. The patched floor (section 2): any batching path where a 1333 share behaves differently from
   Minswap's 1666 beyond the amount?

## 4. In scope: the deploy parameters

Not chosen yet, except the fees and the treasury's shape. **Never reuse Minswap's
`deployed/mainnet/params.json`**: its `poolStakeCredential`
(`52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c2`) is Minswap's key, and a pool deployed
with it pays its ADA staking rewards to Minswap.

| Parameter | What it is | Ours |
|---|---|---|
| Authen seed | a UTxO the deploy spends; fixes our authen policy and every hash after it | ours, chosen at deploy |
| NFT names `MSF`, `MSP`, `MSGS` | constants in Minswap's code, not parameters | unchanged |
| Pool stake credential | where each new pool's ADA is staked, and so who earns its staking rewards (and, since Plomin, which DRep it delegates to) | the venue's |
| Role timelock `Params` | `seed` (a second UTxO), `owner_a`, `owner_b`, `treasury`, `authen_policy_id` (ours) | treasury: a two-key multi-signature wallet, not made yet (below); keys: owner's decision |
| First GlobalSetting | `batchers` = the batcher's key(s); the five roles = `PAMSpendScript(role timelock hash)` | |
| Pools the site opens | base fee 30 / 10000 on both sides (0.3%); fee share switched on at 1333 / 10000 by a `SetPool` announcement | owner's ruling, 2026-10-24 |

**The treasury** is a multi-signature wallet of two keys. The owner's plan (2026-10-24) is
Eternl's multi-sig wallet, which needs Eternl Pro. Not a Lace shared wallet: Lace's own source
calls those "a beta feature (testnet-only)", and Lace 2.x does not migrate them
(input-output-hk/lace @ `d0df8d7e07`,
`packages/module/migrate-v1-data/src/store/v1-data/prepare-preloaded-state.ts`). Both parts of
its address must be scripts that need both keys: the payment part, and the stake part too, since
a one-key stake part lets that key alone withdraw the treasury's staking rewards to any address.
The lock's `treasury` and the batcher's `sweep` setting (draft PR #1008,
`cardano/batcher/README.md` step 8) must hold the same address string: the lock compares whole
addresses.

Order: pick both seeds, compute the authen policy, compute the lock's hash with it, mint the lock
token (both keys sign), then `DexInitialization` with the first GlobalSetting naming the lock.
Changing a key or the treasury later means a new lock and a 48-hour `SetGlobalSetting` to it.

## 5. In scope later: the batcher

Not written. Only Minswap's `src/batcher-sample.ts` is public. It will be an always-on service
that watches our order address, builds batch transactions, holds a hot key with ADA for fees and
collateral, and keeps the batcher fee. It cannot move any role: those are in the lock.

## How money moves in these pools

- **Traders** pay a 0.3% trade fee in every pool the site opens (30 / 10000 of the amount in;
  Minswap's bounds for anyone opening a pool are 0.05% to 20%).
- **LPs** earn that fee minus the venue's share: about 0.26% of each trade once the share is on,
  the whole 0.3% before.
- **The venue** earns 1333 / 10000 of the trade fee (13.33%, so about 0.04% of each trade). A new
  pool starts with the share off (Minswap's factory requires it); switching it on is a `SetPool`
  change, so it starts 48 hours after it is announced, up to 16 announced at once. The share
  accrues inside each pool and the lock pays it only to the treasury. The venue also earns the
  batcher fee per order if it runs the batcher, and the staking rewards of the pools' ADA through
  the pool stake credential. For comparison, Minswap's own pools at 0.3% give Minswap 1/6 of the
  fee (0.05%) and their LPs 0.25%.
- **The split** happens off chain, quarterly, as on the EVM chains: the whole venue share sits in
  the treasury, and the agreed 30/35/35 (later 10/45/45) between the rail, greencifer and the
  island is paid from there. No contract splits it.
- **Minswap** earns nothing from these pools: no fee switch, address or key of Minswap's is in the
  code, only in its own deploy record, which we do not use.

## Decisions that are the owner's

Decided 2026-10-24: the 0.3% fee and the 1333 share (which needed the patch in section 2), the
quarterly split from the treasury, and a two-key treasury (a multi-signature wallet, not made yet: section 4).
Still open:

1. Who holds the role timelock's two owner keys.
2. Where the batcher runs, and who holds its hot key.
3. Which auditor.
4. **The licence.** Minswap's `LICENSE.md` is GPL-3.0; its `aiken.toml` and `plutus.json` say
   Apache-2.0. Our copy and the lock (which compiles against Minswap's library) are marked
   GPL-3.0, the stricter reading, until a lawyer reads it. Owed before any deploy.
