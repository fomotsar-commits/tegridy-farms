# Whetstone module-whitelist petition — `TegridyLiquidityMigrator`

**Status: DRAFT for the operator to send. Nothing here has been sent to Whetstone.**
Claude does not contact third parties; review this, then send it yourself.

Every on-chain figure below was read from Ethereum mainnet on **2026-07-31, around
block 25,656,870–25,656,919**, via `https://ethereum-rpc.publicnode.com`. §4 gives the
exact commands so the reader can reproduce each one. Anything not read from chain or
source is marked as unverified.

---

## 1. What we are asking for

One call from the Airlock owner:

```solidity
// Airlock 0xde3599a2ec440b296373a983c85c365da55d9dfa
// owner   0x21E2ce70511e4FE542a97708e89520471DAa7A66   (Safe 1.4.1, 3-of-6, read on-chain)
//
// Real signature (verified against the deployed source) takes ARRAYS:
//   function setModuleState(address[] calldata modules, ModuleState[] calldata states) external onlyOwner
setModuleState(
  [ <TegridyLiquidityMigrator address — NOT YET DEPLOYED, see §9> ],
  [ 4 ]   // ModuleState.LiquidityMigrator
);
```

Until that lands, `Airlock.create` reverts `WrongModuleState` for any launch that names
our migrator (`Airlock.sol:147`, `_validateModuleState`), so this gate blocks the whole
feature. **It is the long pole — open it before the audit finishes, not after.**

We are **not** asking to be whitelisted today. We are asking to start the review, and to
be told what would have to be true for the answer to be yes. §8 is our own list of what
we think is still missing.

## 2. Who we are

Tegridy Farms (**memetic.fun**) — an existing Doppler integrator on Ethereum mainnet. We
already launch through the canonical Airlock using the stock whitelisted modules
(`DopplerERC20V1Factory` / `UniswapV4Initializer` / `UniswapV4Migrator`), with
`withIntegrator` pointed at our own fee address `0xD355A072d6bBbA275DBD83A3149f6347b06d1051`.

*(Honesty note for our own operator, not for Whetstone: `eth_getCode` on that integrator
address returns `0x` — it is an **EOA**, not a multisig, despite an in-repo comment that
calls it "a Tegridy multisig". Fix the comment or the address before sending.)*

This petition does not change how we launch. It changes only where a launch's liquidity
graduates **to**.

## 3. What the module does

`TegridyLiquidityMigrator` implements `ILiquidityMigrator` (your MIT interface) and
graduates a completed auction into a **canonical Uniswap V4 pool that carries our own
hook**, `TegridyV4Hook`, instead of a hookless pool. Source:
`contracts/src/v4/TegridyLiquidityMigrator.sol` on branch `claude/launcher-own-venue`.

- **`initialize(asset, numeraire, data)`** — decodes
  `(uint24 fee, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[] beneficiaries)`,
  i.e. **byte-identical to what your own `UniswapV4Migrator.initialize` decodes**
  (`src/migrators/UniswapV4Migrator.sol:118-119`), because that is what the SDK emits.
  It builds the `PoolKey` with `hooks = TegridyV4Hook` and
  `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG`, stores it, and returns `address(0)` — same
  convention as yours, so `DERC20.lockPool` is a no-op on this path. The decoded static
  `fee` is deliberately ignored (the hook rejects anything but dynamic-fee).
- **`migrate(sqrtPriceX96, token0, token1, recipient)`** — initializes the pool at the
  supplied price and mints **one full-range position** from the balances the Airlock
  transferred in, then refunds any residue to `recipient`.

Both entrypoints are `onlyAirlock`.

**Where the LP position goes — corrected.** An earlier draft of this document said the
position is *always* minted to the Airlock-supplied `recipient`. That is **not what the
code does**, and we would rather correct it here than have you find it:

```solidity
bool hasConstitution = cfg.beneficiaries.length > 0;
address positionOwner = hasConstitution ? address(feeLocker) : recipient;
```

- **No declared fee split** → the position is minted directly to `recipient`, which
  `Airlock.migrate` sets to the launch's own timelock (`Airlock.sol:223`).
- **A declared fee split** → the position is minted to **`TegridyFeeLocker`**
  (`contracts/src/v4/TegridyFeeLocker.sol`), our own independent equivalent of your
  `StreamableFeesLocker`. It collects the position's fees permissionlessly, credits each
  beneficiary pull-style, and releases the position to the launch's recipient at
  `unlockDate` (`unlockDate == 0` ⇒ permanent).

Either way the migrator itself keeps nothing, and neither contract has a path that moves
the position anywhere a caller chooses.

---

## 4. 🔴 The thing you should check first: your mandatory 5% floor

**This is the single biggest obstacle to approval, and it is real. We are raising it
ourselves rather than letting you find it.**

### What the stock path enforces

Your `UniswapV4Migrator.initialize` calls, at `src/migrators/UniswapV4Migrator.sol:123-124`:

```solidity
storeBeneficiaries(
    PoolId.wrap(0), beneficiaries, Airlock(airlock).owner(), MIN_PROTOCOL_OWNER_SHARES, storeBeneficiary
);
```

with `MIN_PROTOCOL_OWNER_SHARES = uint96(WAD / 20)` — 5% — from
`src/types/BeneficiaryData.sol`. We verified this **live against the deployed contract**,
not from source alone. Four `eth_call`s against
`UniswapV4Migrator 0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5` with `from = Airlock`:

| Probe | `beneficiaries` | Result |
| --- | --- | --- |
| A | `[(0x…deadbeef, 1e18)]` — owner absent | revert `0xdfa06864` = `InvalidProtocolOwnerBeneficiary()` |
| B | `[(0x21E2…7A66, 1e18)]` — owner present | **success**, returns `address(0)` |
| C | `[(0x…deadbeef, 0.96e18), (0x21E2…7A66, 0.04e18)]` | revert `0x2b6dc823` = `InvalidProtocolOwnerShares(required = 5e16, provided = 4e16)` |
| D | probe B's payload, `from` = a random EOA | revert `0x6c2ffca6` = `SenderNotAirlock()` |

Probe C is the proof: the contract itself told us the required minimum is `5e16` — 5% of
WAD — measured, not assumed.

### Where that enforcement actually lives

**In the module, never in the Airlock.** `Airlock.sol` contains no beneficiary logic at
all (zero matches for `beneficiar` in its verified source). Scanning deployed runtime
bytecode for the `InvalidProtocolOwnerShares(uint96,uint96)` selector `2b6dc823`:

| Contract | Runtime size | 5%-floor selector |
| --- | --- | --- |
| `Airlock` `0xde35…9dfa` | 5,707 B | **absent** |
| `UniswapV4Migrator` `0x0820…05f5` | 10,616 B | **PRESENT** |
| `UniswapV4ScheduledMulticurveInitializer` `0xf843…3876` | 14,989 B | PRESENT |
| `StreamableFeesLockerV2` `0xce32…3d47` | 9,347 B | PRESENT |
| `UniswapV4Initializer` `0x53b4…e8ad` | 2,698 B | absent |
| `StreamableFeesLocker` `0xe24f…1ec6` | 7,198 B | absent |
| `UniswapV2Migrator` `0x7658…3dff2` | 3,602 B | absent |
| `UniswapV4MigratorHook` `0x4053…e500` | 2,339 B | absent |

Our launches use `UniswapV4Initializer` (selector absent). So for the launches we
actually ship, **`UniswapV4Migrator` is the only contract in the whole path that enforces
your floor.** Replace it and the enforcement is gone.

### ✅ RESOLVED — we now enforce it on-chain (was: nothing)

**This section originally read "nothing on-chain", and that was true when the petition
was drafted.** We fixed it rather than ask you to accept it. `initialize` now reads
`Airlock.owner()` **live** and requires it to hold at least `PROTOCOL_OWNER_MIN_SHARES
= 5e16` of the beneficiary list, reverting `InvalidProtocolOwnerBeneficiary()` when the
owner is absent and `InvalidProtocolOwnerShares(5e16, actual)` when it is short — the
**same selectors your own module returns** (`0xdfa06864` / `0x2b6dc823`), so an
integrator decoding a revert cannot tell the two modules apart on this point.

The owner is read live rather than pinned at construction precisely because your owner
is a 3-of-6 Safe: a pinned copy would turn a Safe rotation into a revert on every
graduation. Duplicate owner entries are summed rather than first-match, so a list you
would accept is not rejected by us.

Five tests cover it: owner absent, owner below the floor (asserting the exact
`(5e16, 4e16)` args), exactly-at-floor accepted, duplicate entries summed, and an owner
rotation followed live. **Verify with §10.**

<details>
<summary>The original finding, kept for the record</summary>

#### What our module did about it: nothing on-chain


Stated plainly, because it is true:

1. `TegridyLiquidityMigrator.initialize` contains **no reference to `Airlock.owner()`**,
   no minimum-share constant, and no protocol-owner check. It reverts
   `FeeConstitutionUnsupported()` only when `beneficiaries.length > 0 && feeLocker == address(0)`.
2. A **zero-length** beneficiary list is accepted outright. `migrate` then takes the
   `hasConstitution == false` branch, mints straight to the timelock, never touches the
   locker — and **no beneficiary, including you, is paid anything from LP fees.**
3. `TegridyFeeLocker.lockPosition` validates strictly — non-empty, no zero shares,
   strictly ascending addresses, shares summing to exactly `WAD` — but has **no
   protocol-owner requirement** either.
4. The 5% line exists only in our **frontend TypeScript**:
   `frontend/src/lib/launcher/airlock.ts` (`DOPPLER_MIN_SHARE_BPS = 500`;
   `feeConstitutionToBeneficiaries` throws below it) and `launchService.ts`
   (`resolveFeeConstitution`, where the Doppler line is fixed and cannot be carved away).
   `Airlock.create` is permissionless — anyone can call it with our migrator address and
   an empty beneficiary list, and our TypeScript is not in the loop.
5. `contracts/test/v4/TegridyLiquidityMigrator.t.sol` has 16 `test` functions and **zero
   mentions of `protocolOwner` or `airlockOwner`**. `doppler` appears twice, both in
   comments (lines 28 and 320) and neither in an assertion. **No test exercises the floor,
   because nothing implements it.**

**Read from your side, whitelisting the module AS ORIGINALLY WRITTEN would have removed your
protocol-owner revenue floor from every launch that routed through it.** That was a fair
reading, we did not argue otherwise, and it is the reason the floor is now enforced in code.

</details>

### What we propose

We would rather match your invariant than negotiate around it. Our preference, in order:

- **(a) Reimplement the floor on-chain, in the migrator.** Mirror your
  `storeBeneficiaries` semantics: read `Airlock(airlock).owner()` **live** in
  `initialize`, require it to be present with `>= WAD/20`, and reject the empty list.
  This is a small, self-contained change and it makes the on-chain guarantee identical to
  yours rather than merely equivalent-in-our-UI. **We will ship this before asking for a
  yes**, unless you tell us you want a different shape.
- **(b) Make the floor a condition of the whitelist.** We are happy for the grant to be
  contingent on (a) landing at a specific, verified, immutable address.
- **(c) If you would rather we simply do not have this module** — that is an acceptable
  answer and we will keep using `UniswapV4Migrator`. We would still like to know it now
  rather than after an audit spend.

### A second-order risk we are creating for you

Your check reads `Airlock(airlock).owner()` **live, at `create` time**. Ours hardcodes
`0x21E2ce70511e4FE542a97708e89520471DAa7A66` in frontend config. Today those agree — we
read `Airlock.owner()` on-chain and got that address byte-for-byte.

But the failure modes differ, and ours is worse:

| | Stock `UniswapV4Migrator` | `TegridyLiquidityMigrator` as written |
| --- | --- | --- |
| Airlock ownership rotates | `create()` **reverts** `InvalidProtocolOwnerBeneficiary()` — fail-closed, loud (this is exactly probe A above) | nothing reverts; the launch silently streams your 5% to the **stale** address forever |

So the review claim "our hardcoded `airlockOwner` must match `Airlock.owner()` live or
everything reverts" is **true today and true of the stock path — but it is `create()`
that reverts, not graduation**, and it stops being true the moment our migrator is in
the path. Fix (a) restores the fail-closed behaviour. Until it lands, a Whetstone
ownership rotation would be a silent misdirection of your own fees, which is a worse
outcome for you than a revert.

---

## 5. What this means for Doppler's fee take

A launch pays Doppler on **two independent legs**. Only one of them is affected.

| Leg | Where it is computed | Effect of whitelisting our migrator |
| --- | --- | --- |
| **Auction-phase protocol fee** — `max(fees/20, (balance-fees)/1000)`, capped at `fees/5`, accrued to `getProtocolFees[token]` and withdrawn by the owner via `collectProtocolFees` | `Airlock._handleFees`, called at `Airlock.sol:210-211` **before** any balance is transferred to the migrator | **Unaffected, structurally.** It is computed in `Airlock.sol`, which we do not touch and cannot influence. No migrator can reduce or reroute it. |
| **Post-graduation LP fee stream** — `>= 5%` of the graduated pool's LP fees | `UniswapV4Migrator.initialize` → `storeBeneficiaries`, paid out by `StreamableFeesLocker` | **This is the one at risk.** As written, our module drops the enforcement (§4). Even with §4 fix (a) applied, the payout contract becomes **`TegridyFeeLocker`, ours, which you have never reviewed** — you would be depending on our accounting rather than your own. |
| **Integrator fee** — `getIntegratorFees[integrator][token]` | `Airlock._handleFees` | Unaffected. Ours today, ours after. |

**And one thing that is new, that has no analogue in the stock path.** `TegridyV4Hook`
takes a **POL skim** in `_afterSwap`: `polSkimBps` of the swap's *unspecified* currency,
accrued to us as ERC-6909 claims. Deploy-script values
(`contracts/script/DeployV4.s.sol:52-56`):

| Param | Value | Mutable? |
| --- | --- | --- |
| `polSkimBps` (initial) | **100 bps = 1% of swap output** | yes, by `paramAdmin` |
| `maxPolSkimBps` (ceiling) | **1,000 bps = 10%** | **no — immutable at construction** |
| `minFeePips` / `maxFeePips` | 500 (0.05%) / 30,000 (3%) | **no — immutable** |
| `baseFeePips` (initial LP fee) | 3,000 (0.30%) | yes, by `paramAdmin`, bounded by the two immutables |

That skim is a claim on the same trade flow your 5% is a claim on, and none of it reaches
beneficiaries. We think you should price that into your answer rather than discover it in
a block explorer. A hookless stock graduation has no skim at all.

## 6. What the module does NOT do

| Concern | Answer |
| --- | --- |
| Can the migrator keep the launch's liquidity? | **No.** One mint, to `recipient` or to `TegridyFeeLocker`; never to itself. Residue is refunded to `recipient` in the same call. |
| Can the locker keep it? | **No.** `release(tokenId)` sends the position to the recipient recorded at lock time, after `unlockDate`. `collect` performs a `DECREASE_LIQUIDITY` of **zero** liquidity — principal is untouchable by it. |
| Can anyone call the migrator? | **No.** `initialize` and `migrate` are both `onlyAirlock`. |
| Is the migrator upgradeable / owner-controlled? | **No.** No proxy, no owner, no setters — every parameter is `immutable`. |
| Is the locker? | **Almost.** One write-once function, `bindMigrator`, callable by the deployer exactly once (the migrator↔locker reference is circular at construction). After it fires, nothing can change it. Everything else is immutable. |
| Is the hook? | **No — but it has a live `paramAdmin`.** Fee, skim, split, sinks and pause are settable, all bounded by constructor immutables. The hook cannot seize or lock LP principal; the worst a captured `paramAdmin` can do is a 3% LP fee, a 10% skim, and a swap pause (liquidity removal stays open). |
| What if `migrate` reverts? | `Airlock.migrate` transfers balances in **before** calling us (`Airlock.sol:216-221`), so a revert strands them in our contract. `sweepStuck(token)` is a permissionless recovery whose destination is an **immutable** `rescueRecipient` — the caller chooses nothing. |
| Refund to an ETH-rejecting recipient? | Emits `RefundFailed` rather than reverting, so a hostile recipient cannot undo a completed graduation. The dust stays recoverable via `sweepStuck`. |

## 7. Licensing — we did not fork anything of yours

We read `UniswapV4Migrator.sol` and `StreamableFeesLocker.sol` to understand the Airlock's
call sequence, then wrote independent implementations. Doppler core is **BUSL-1.1** with
no registered Additional Use Grant — `doppler-license-grants.whetstoneresearch.eth` was
unregistered when we checked on **2026-07-16** and again on **2026-07-28** — so production
forking is barred until 2027-12-31.

The only Doppler surfaces we depend on are the MIT ones: `ILiquidityMigrator`, the
`BeneficiaryData` struct shape (restated, not imported, since core is not vendored), and
`TickLibrary` conventions. `TegridyFeeLocker` is a clean-room pull-payment design, not a
port of `StreamableFeesLocker`. **If you read anything in our implementation as a
derivative of the BUSL sources, tell us and we will change it.** That offer is real; we
would rather rewrite than argue.

## 8. Audit status — unaudited

**Neither `TegridyLiquidityMigrator` nor `TegridyFeeLocker` nor `TegridyV4Hook` has been
audited by anyone.** There is no report to attach. An external audit is planned as part of
our V4 work but is not booked, and we are not going to imply otherwise.

Neither contract has been deployed to mainnet. The addresses in §9 are blank because they
do not exist yet.

## 9. What we still owe you before you should say yes

> **Updated:** item 1 (the on-chain 5% floor) is **DONE** — see §4. The rest stand.


Our own list, unprompted:

1. **The on-chain 5% floor (§4 fix (a)).** Not started. This is the blocker, and it is
   ours, not yours.
2. **Tests for it.** Today `TegridyLiquidityMigrator.t.sol` has 16 tests and none of them
   is about your beneficiary. A floor with no failing-first test is not a floor.
3. **An external audit report** covering the migrator, the locker and the hook. Not
   booked.
4. **Deployment + Etherscan verification**, so you can read the deployed bytecode rather
   than a branch.
5. **A real multisig.** Right now nearly every Tegridy contract is owned by a **hot
   deployer EOA**, `0x14898258122C0740106391E6e8E4F17F3b6d456E`. A three-Safe rebuild
   (Treasury 3-of-5 / Admin 3-of-5 / Guardian 2-of-3, disjoint hardware-key signer sets)
   is written up in `docs/SAFE_REHOME_RUNBOOK.md` but **has not been executed**. The
   migrator's `rescueRecipient` and the hook's `paramAdmin` must both point at that Safe,
   not at the EOA, before this is a serious request.
6. **The hook's standing initializer allowance.** `TegridyV4Hook` must grant the migrator
   `proposeInitializerAllowed` → 48h → `executeInitializerAllowed`. Without it `migrate()`
   reverts at `poolManager.initialize` with `PoolNotAllowed()` — and since `Airlock.migrate`
   is permissionless and has already moved the funds, that reverts *after* the transfer
   and strands a real launch's liquidity. This is an operational failure we would be
   inflicting on your users, so it belongs on this list.

Items 1, 2, 5 and 6 are entirely within our control and should land before any yes. Item 3
is the long one, which is why we are opening this now rather than in three months.

## 10. Verify everything above yourself

Nothing here needs to be taken on faith. Reproduce with `cast`:

```bash
RPC=https://ethereum-rpc.publicnode.com
AIRLOCK=0xde3599a2ec440b296373a983c85c365da55d9dfa
V4MIG=0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5

# The owner we address this to, and its Safe shape
cast call $AIRLOCK "owner()(address)" --rpc-url $RPC
cast call 0x21E2ce70511e4FE542a97708e89520471DAa7A66 "VERSION()(string)"      --rpc-url $RPC
cast call 0x21E2ce70511e4FE542a97708e89520471DAa7A66 "getThreshold()(uint256)" --rpc-url $RPC
cast call 0x21E2ce70511e4FE542a97708e89520471DAa7A66 "getOwners()(address[])"  --rpc-url $RPC

# The module-state value we are asking for (the stock V4 migrator returns 4)
cast call $AIRLOCK "getModuleState(address)(uint8)" $V4MIG --rpc-url $RPC

# Probe C from §4: the contract itself reports the 5e16 minimum.
# beneficiaries = [(0x..deadbeef, 0.96e18), (0x21E2..7A66, 0.04e18)]
DATA=$(cast abi-encode "f(uint24,int24,uint32,(address,uint96)[])" 3000 60 0 \
  "[(0x00000000000000000000000000000000DeaDBeef,960000000000000000),\
(0x21E2ce70511e4FE542a97708e89520471DAa7A66,40000000000000000)]")
CALL=$(cast calldata "initialize(address,address,bytes)" \
  0x1111111111111111111111111111111111111111 \
  0x0000000000000000000000000000000000000000 $DATA)
cast call $V4MIG --from $AIRLOCK --data $CALL --rpc-url $RPC
# => execution reverted, data "0x2b6dc823" ++ required(5e16) ++ provided(4e16)
#    0x2b6dc823 == cast sig "InvalidProtocolOwnerShares(uint96,uint96)"

# The floor is in the MODULE, not the Airlock — selector 2b6dc823 present/absent:
cast code $V4MIG   --rpc-url $RPC | grep -c 2b6dc823   # 1
cast code $AIRLOCK --rpc-url $RPC | grep -c 2b6dc823   # 0
```

Source: our migrator, locker and hook are at `contracts/src/v4/` on branch
`claude/launcher-own-venue`. Doppler's deployed sources are Etherscan-verified at the
addresses above; §4's line references are to that verified source, not to a fork.

## 11. Addresses / contact

| Item | Value |
| --- | --- |
| Airlock | `0xde3599a2ec440b296373a983c85c365da55d9dfa` |
| Airlock owner (this petition's recipient) | `0x21E2ce70511e4FE542a97708e89520471DAa7A66` — Safe 1.4.1, **3-of-6** |
| `TegridyLiquidityMigrator` | **TBD — not deployed.** Deploy + verify, then fill in. |
| `TegridyFeeLocker` | **TBD — not deployed.** |
| `TegridyV4Hook` | **TBD — not deployed.** |
| Deployer (current owner of nearly everything — see §9.5) | `0x14898258122C0740106391E6e8E4F17F3b6d456E` |
| Integrator address (existing launches) | `0xD355A072d6bBbA275DBD83A3149f6347b06d1051` (EOA) |
| Audit report | **None exists.** |
| Contact | _(operator to supply)_ |

---

## 12. Operator checklist before sending

Do these in order. Steps 1–3 are the difference between a serious petition and one that
gets a polite no.

- [ ] **Implement §4 fix (a)** — read `Airlock(airlock).owner()` live in
      `TegridyLiquidityMigrator.initialize`, require it present at `>= WAD/20`, reject the
      empty beneficiary list. Then re-read §4 and delete the paragraphs that say we
      haven't.
- [ ] **Write the tests for it**, mutation-checked (revert the fix, confirm RED).
- [ ] **Execute `docs/SAFE_REHOME_RUNBOOK.md`.** Point `rescueRecipient` and the hook's
      `paramAdmin` at the rebuilt Safes, **not** the deployer EOA.
- [ ] Book the external audit; attach the report, or say plainly that it is pending.
- [ ] Deploy `TegridyV4Hook` (`DeployV4.s.sol`, HookMiner salt), `TegridyFeeLocker`,
      then the migrator; `bindMigrator`; fill in all three addresses in §11.
- [ ] Etherscan-verify all three.
- [ ] Grant the hook's standing initializer allowance
      (`proposeInitializerAllowed` → 48h → `executeInitializerAllowed`).
- [ ] Fix or replace the "a Tegridy multisig" comment on the integrator address in
      `frontend/src/lib/launcher/config.ts` / `airlock.ts` (§2).
- [ ] Re-read §5 and confirm the POL-skim numbers still match `DeployV4.s.sol`.
- [ ] Re-run every command in §10 immediately before sending. If `Airlock.owner()` has
      changed, §1, §4 and §11 are all stale.

---

## 13. Covering note (paste into email / Discord)

> Subject: Module-whitelist review request — custom `LiquidityMigrator` (Tegridy Farms / memetic.fun)
>
> Hi — we're Tegridy Farms (memetic.fun), an existing Doppler integrator on Ethereum
> mainnet. We already launch through the canonical Airlock with the stock modules
> (`DopplerERC20V1Factory` / `UniswapV4Initializer` / `UniswapV4Migrator`), integrator
> `0xD355A072d6bBbA275DBD83A3149f6347b06d1051`.
>
> We'd like to eventually ask you to whitelist a `LiquidityMigrator` of our own —
> `Airlock.setModuleState([migrator], [4])` — so completed auctions graduate into a
> canonical Uniswap V4 pool carrying our hook instead of a hookless one. The LP position
> still goes to the launch (its timelock, or a fee-locker that pays the launch's declared
> beneficiaries); we never hold it.
>
> We're writing early and deliberately **not** asking for a yes yet, because there's a
> problem we'd rather raise ourselves than have you find:
>
> **Your mandatory ≥5%-to-Airlock-owner beneficiary floor lives inside
> `UniswapV4Migrator.initialize`, not inside `Airlock.sol`.** We verified this live —
> calling the deployed migrator with a beneficiary list that omits the owner reverts
> `InvalidProtocolOwnerBeneficiary()`, and with the owner at 4% it reverts
> `InvalidProtocolOwnerShares(required 5e16, provided 4e16)`. The same selector is absent
> from the Airlock's own bytecode. So a custom migrator removes that floor from the
> migration leg — and ours, as currently written, doesn't reimplement it. Your
> auction-phase protocol fee (`Airlock._handleFees`) is untouched either way, since it's
> computed in `Airlock.sol` before anything reaches a migrator.
>
> We intend to reimplement the floor on-chain with your exact semantics (live
> `Airlock.owner()` read, `>= WAD/20`, empty lists rejected) and would be happy for any
> whitelist to be conditional on that landing at a specific verified address. We'd also
> flag that our hook takes a POL skim on swap output — 1% initially, hard-capped at 10% by
> an immutable — which has no analogue in a stock hookless graduation, and which you
> should factor in.
>
> Current honest status: nothing is deployed, nothing is audited, and our contracts are
> still owned by a deployer EOA rather than the multisig we've speced. All of that is on
> us to fix before this is a real request.
>
> What we're actually asking now: is a custom `LiquidityMigrator` something you'd consider
> at all, and if so, what would need to be true for the answer to be yes? Happy to share
> the full contracts and our own write-up — including the verification commands so you can
> reproduce every claim above rather than take our word for it.
>
> Thanks,
> — [operator]
