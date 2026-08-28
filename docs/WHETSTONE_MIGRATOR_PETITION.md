# Whetstone petition — module whitelist for `TegridyLiquidityMigrator`, plus the BUSL grant question

**Status: DRAFT for the operator to send. Nothing here has been sent to Whetstone.**
Claude does not contact third parties. Review this, work §15, then send it yourself.

Two asks travel in this one document, because they go to the same party and each is cheap
to answer next to the other:

| | Ask | Who answers |
| --- | --- | --- |
| **A** | Whitelist a custom `LiquidityMigrator` on the Airlock, on deploy — `setModuleState` to `ModuleState.LiquidityMigrator` | the Airlock owner (a Safe) |
| **B** | Register — or tell us you will not register — a **BUSL-1.1 Additional Use Grant** for Doppler core | whoever holds Whetstone's licensing decision |

They are independent. A "yes" to A does not need B, and B matters to us whether or not A
lands. §10 is ask B; everything before it is ask A.

---

## 0. Provenance, and what is stale

This document mixes three kinds of claim. They are not equally fresh, and mixing them
silently is how a petition ends up pointing a third party at something that is not there.

| Claim class | Last established | Re-verifiable by us today? |
| --- | --- | --- |
| **Our own source and tests** — every statement about `TegridyLiquidityMigrator`, `TegridyFeeLocker`, `TegridyV4Hook`, `TegridyV4HookAdmin`, `DeployV4.s.sol` | **re-read from the working tree 2026-08-19** | yes — and it was |
| **On-chain reads** — Airlock owner and its Safe shape, module states, the four `initialize` probes in §6, the bytecode-selector table | **2026-07-31**, around block 25,656,870–25,656,919, via `https://ethereum-rpc.publicnode.com` | **no.** Not re-read since. |
| **Doppler source line references** — `Airlock.sol:NNN`, `UniswapV4Migrator.sol:NNN` | read from the **Etherscan-verified** sources on 2026-07-31 | **no.** Doppler is not vendored in our repo, so we cannot re-check a line number offline. |

**The rule this imposes on the operator: re-run every command in §13 immediately before
sending.** If any of them disagrees with what is written here, do not send — fix the
document. A stale `Airlock.owner()` invalidates §2, §6 and §14 simultaneously.

### 0.1 Corrections since the 2026-07-31 draft

The earlier draft was never sent, which is the only reason these are corrections rather
than retractions. Recorded so nobody re-introduces them.

| Was | Now | Why it mattered |
| --- | --- | --- |
| Pointed at branch `claude/launcher-own-venue` as the place to read the code | **No branch or commit is named.** §4 gives file paths; §13 gives a command the reader runs against whatever commit we hand them | The branch tip did **not** contain `PROTOCOL_OWNER_MIN_SHARES`. We would have pointed Whetstone at a tree missing the exact fix the document claims. That is worse than sending nothing. |
| §9 item 1: the on-chain 5% floor is "Not started" — while §4 said "RESOLVED" | §6 states it is implemented, with constant name, error selectors and the five test names; §12 no longer lists it | The document contradicted itself in two places. A reader resolves that against us. |
| §9 item 2: the migrator's test file "has 16 tests and none is about your beneficiary" | 21 tests, five of them the floor (§5) | Same drift, opposite direction. |
| Named the hook's `paramAdmin` as one of the two things a Safe must sit on | `paramAdmin` is **`TegridyV4HookAdmin`** and is immutable on the hook. The Safe's control point is that **admin contract's owner**; the other is the migrator's `rescueRecipient` (§12) | A reviewer who read `hook.paramAdmin()` and compared it to a Safe address would find a contract instead, and read the mismatch as a lie. |
| Cited POL and fee parameters by `DeployV4.s.sol:52-56` | Cited by constant **name** (§7) | Line numbers drift on every edit; names do not. |
| "an in-repo comment calls the integrator address a Tegridy multisig" — stated as one open defect | Two sites; **one already corrected**, one still wrong (§3) | Half-fixed is not fixed, and claiming it whole would be false either way. |
| Covering note said our module "doesn't reimplement" the floor | Rewritten (§16) | It was the single most load-bearing sentence in the whole send, and it is now false. |

---

## 1. The shape of ask A, in one paragraph

We would like completed Doppler auctions that launched through **our** integrator to
graduate into a canonical Uniswap V4 pool that carries **our** hook, instead of a hookless
one. Doing that requires replacing one Airlock module — the `LiquidityMigrator` — with a
contract we wrote. Airlock modules are whitelisted, so this is your decision, not ours.

**Nothing is deployed.** We are asking you to agree to whitelist a contract **on deploy**,
against a bytecode you will have verified first — not to whitelist something already live.
§12 is our own list of what is still missing before you should say yes.

## 2. The precise ask — one call, checkable by you

```solidity
// Airlock  0xde3599a2ec440b296373a983c85c365da55d9dfa
// caller   the Airlock's own owner() — a Safe (see §14)
//
// The real deployed signature takes ARRAYS. A single-address form does not exist:
//   function setModuleState(address[] calldata modules, ModuleState[] calldata states)
//       external onlyOwner
setModuleState(
  [ <TegridyLiquidityMigrator — address unknown until deploy, see §12> ],
  [ 4 ]   // ModuleState.LiquidityMigrator
);
```

Three things make this checkable rather than asserted:

1. **The state value is not our guess.** `getModuleState` on your own
   `UniswapV4Migrator` (`0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5`) returns `4`. §13
   reproduces that read.
2. **Only the Airlock owner can do it** (`onlyOwner`), which is why this document is
   addressed there and not to an integrator support channel.
3. **Until it lands, our launches cannot even be created.** `Airlock.create` runs
   `_validateModuleState` and reverts `WrongModuleState` for any params naming a module
   that is not in the expected state (`Airlock.sol:147`, read from the Etherscan-verified
   source 2026-07-31 — see §0). So this gate is upstream of everything else we build; it
   is the long pole, and it is worth opening before an audit finishes rather than after.

We would be glad for the grant to be **conditional** — on a specific address, a specific
verified bytecode, an audit report, or all three. A conditional yes is more useful to us
than an unconditional maybe.

## 3. Who we are

Tegridy Farms (**memetic.fun**) — an existing Doppler integrator on Ethereum mainnet. We
already launch through the canonical Airlock using the stock whitelisted modules
(`DopplerERC20V1Factory` / `UniswapV4Initializer` / `UniswapV4Migrator`), with
`withIntegrator` pointed at `0xD355A072d6bBbA275DBD83A3149f6347b06d1051`.

That integrator address is an **EOA**, not a multisig. It was chosen deliberately (single
key, fee-receiving only, no admin power over anything), and it is recorded as such in
`frontend/src/lib/launcher/config.ts`.

> **Operator note, not for Whetstone.** One sibling site still describes it wrongly:
> `frontend/src/lib/launcher/airlock.ts:107` reads *"the integrator address … (a Tegridy
> multisig)"*. `config.ts:28` was corrected and now says EOA. Fix the second one before
> sending, so a reader who greps the repo finds one story rather than two.

Ask A does not change how we launch. It changes only where a launch's liquidity graduates
**to**.

## 4. The module

| | |
| --- | --- |
| Contract | `TegridyLiquidityMigrator` |
| Source | `contracts/src/v4/TegridyLiquidityMigrator.sol` (548 lines) |
| Interface implemented | `ILiquidityMigrator` — your MIT surface |
| Companions | `contracts/src/v4/TegridyFeeLocker.sol` (324), `contracts/src/v4/TegridyV4Hook.sol` (467), `contracts/src/v4/TegridyV4HookAdmin.sol` |
| Deploy script | `contracts/script/DeployV4.s.sol` |
| Deployed | **no** |
| Audited | **no** (§11) |

We are not naming a branch or a commit hash in this document. An earlier draft did, and
the tip it named did not contain the fix the draft claimed — §0.1. When we hand you a tree,
§13 gives you a one-line command to confirm for yourself that the fix is in the tree you
were handed, rather than taking a pointer on trust.

**`initialize(asset, numeraire, data)`** decodes
`(uint24 fee, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[] beneficiaries)` —
byte-identical to what your own `UniswapV4Migrator.initialize` decodes
(`UniswapV4Migrator.sol:118-119`, per §0), because that is what the SDK emits. It builds
the `PoolKey` with `hooks = TegridyV4Hook` and `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG`,
stores it, and returns `address(0)` — same convention as yours, so `DERC20.lockPool` is a
no-op on this path. The decoded static `fee` is deliberately ignored: the hook reverts
`NotDynamicFee()` on anything but the dynamic-fee flag, so honouring a caller's static fee
would only build a pool that cannot migrate.

It rejects, before storing anything:

| Condition | Revert |
| --- | --- |
| beneficiaries declared but no fee locker wired | `FeeConstitutionUnsupported()` |
| Airlock owner absent from a non-empty beneficiary list | `InvalidProtocolOwnerBeneficiary()` |
| Airlock owner present below the floor | `InvalidProtocolOwnerShares(5e16, actual)` |
| a lock duration with nobody to pay | `LockDurationUnsupported()` |
| `tickSpacing` outside v4-core's own bounds | `InvalidTickSpacing()` |

**`migrate(sqrtPriceX96, token0, token1, recipient)`** initializes the pool at the supplied
price and mints **one full-range position** from the balances the Airlock transferred in,
then refunds any residue to `recipient`. Both entrypoints are `onlyAirlock`.

### 4.1 Where the LP position goes

Stated exactly, because an earlier draft of this document got it wrong in our own favour:

```solidity
bool hasConstitution = cfg.beneficiaries.length > 0;
address positionOwner = hasConstitution ? address(feeLocker) : recipient;
```

- **No declared fee split** → minted directly to `recipient`, which `Airlock.migrate` sets
  to the launch's own timelock (`Airlock.sol:223`, per §0).
- **A declared fee split** → minted to **`TegridyFeeLocker`**, our own independent
  equivalent of your `StreamableFeesLocker`. It collects the position's fees
  permissionlessly, credits each beneficiary pull-style, and releases the position to the
  launch's recorded recipient at `unlockDate` (`unlockDate == 0` ⇒ permanent, no release
  path exists).

Either way the migrator keeps nothing, and neither contract has a path that moves the
position anywhere a caller chooses.

**Be clear about what that is and is not.** A time-locked position in a locker we wrote is
a **weaker** trust claim than a burned position. After `unlockDate` the recipient can
withdraw. We would rather you price that than let the word "locked" carry more weight than
the contract does.

## 5. Test coverage

Foundry, `contracts/test/v4/`. Counted from the working tree 2026-08-19.

| File | `test*` functions | Covers |
| --- | --- | --- |
| `TegridyLiquidityMigrator.t.sol` | **21** | full-range mint, migrator retains nothing, pool carries the hook, `onlyAirlock` on both entrypoints, unconfigured-pair revert, tick-spacing bounds, the SDK payload shape, beneficiary routing to the locker, lock-duration rejection, `sweepStuck` destination, initializer-grant load-bearing, and the five floor tests below |
| `TegridyFeeLocker.t.sol` | **19** | write-once `bindMigrator`, only-migrator lock, shares-sum-to-WAD, duplicate/unsorted/zero-share rejection, double-lock, permanent lock never releases, timed lock blocks before expiry, exact split with no dust, hostile beneficiary cannot block others, collect + claim are reentrancy-guarded (donate-mid-collect cannot corrupt the delta) |
| `TegridyV4Hook.t.sol` | **39** | pool-key allowlist, dynamic-fee gate, admin timelock flows, POL accrual/redeem/conservation fuzz, fee bounds fuzz, fee-split conservation, pause semantics, trusted-router paths |

The five that exist because of §6, by name so you can grep rather than trust a count:

```
test_initialize_rejectsAConstitutionThatOmitsTheProtocolOwner
test_initialize_rejectsAProtocolOwnerShareBelowTheFloor      // asserts the exact (5e16, 4e16) args
test_initialize_acceptsExactlyTheFloor
test_initialize_sumsDuplicateProtocolOwnerEntries
test_initialize_followsAnAirlockOwnerRotation                // owner rotates mid-test; the read follows it
```

Tested is not audited. §11.

---

## 6. 🔴 Your mandatory 5% floor — check this first

**This was the single biggest obstacle to approval. We raised it ourselves rather than let
you find it, and then we fixed it.**

### What the stock path enforces

Your `UniswapV4Migrator.initialize` calls (`UniswapV4Migrator.sol:123-124`, per §0):

```solidity
storeBeneficiaries(
    PoolId.wrap(0), beneficiaries, Airlock(airlock).owner(), MIN_PROTOCOL_OWNER_SHARES, storeBeneficiary
);
```

with `MIN_PROTOCOL_OWNER_SHARES = uint96(WAD / 20)` — 5% — from
`src/types/BeneficiaryData.sol`. We verified that **live against the deployed contract**,
not from source alone. Four `eth_call`s against `UniswapV4Migrator`
`0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5` with `from = Airlock`, on **2026-07-31**
(§0 — not re-read since):

| Probe | `beneficiaries` | Result |
| --- | --- | --- |
| A | `[(0x…deadbeef, 1e18)]` — owner absent | revert `0xdfa06864` = `InvalidProtocolOwnerBeneficiary()` |
| B | `[(0x21E2…7A66, 1e18)]` — owner present | **success**, returns `address(0)` |
| C | `[(0x…deadbeef, 0.96e18), (0x21E2…7A66, 0.04e18)]` | revert `0x2b6dc823` = `InvalidProtocolOwnerShares(required 5e16, provided 4e16)` |
| D | probe B's payload, `from` = a random EOA | revert `0x6c2ffca6` = `SenderNotAirlock()` |

Probe C is the proof: the contract itself reported the minimum as `5e16`. Measured, not
assumed.

### Where that enforcement lives

**In the module, never in the Airlock.** `Airlock.sol` contains no beneficiary logic at all
(zero matches for `beneficiar` in its verified source). Scanning deployed runtime bytecode
for the `InvalidProtocolOwnerShares(uint96,uint96)` selector `2b6dc823` — again 2026-07-31:

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

Our launches use `UniswapV4Initializer` (selector absent). So for the launches we actually
ship, **`UniswapV4Migrator` is the only contract in the whole path that enforces your
floor.** Replace it and the enforcement is gone — which is precisely the objection a
reviewer should raise against ask A.

### ✅ We enforce it on-chain, in the module

`TegridyLiquidityMigrator.initialize` reads `Airlock.owner()` **live** and requires it to
hold at least `PROTOCOL_OWNER_MIN_SHARES` of the beneficiary list. Verified in the working
tree 2026-08-19:

| What | Where |
| --- | --- |
| `uint96 public constant PROTOCOL_OWNER_MIN_SHARES = 5e16;` | `TegridyLiquidityMigrator.sol:151` |
| `error InvalidProtocolOwnerBeneficiary();` | `:118` |
| `error InvalidProtocolOwnerShares(uint96 expected, uint96 actual);` | `:122` |
| live read `IAirlockOwner(airlock).owner()` | `:288` |
| duplicate entries **summed**, not first-match | `:292-299` |
| both reverts | `:300-303` |

Three choices in there worth stating, because each is a place we could have been subtly
wrong:

- **The owner is read live, not pinned at construction.** Your owner is a Safe and can be
  rotated. A pinned copy would turn a rotation into a revert on every graduation — and
  would silently misdirect your share until someone noticed.
- **Duplicate owner entries are summed.** First-match would under-count the owner's real
  take and reject a list you would have accepted.
- **The errors are the same two selectors your module returns** (`0xdfa06864` /
  `0x2b6dc823`), so an integrator decoding a revert cannot tell the two modules apart on
  this point.

Five tests, named in §5. `PROTOCOL_OWNER_MIN_SHARES` is the string to grep for; §13 gives
the command.

### The failure mode this closes

| | Stock `UniswapV4Migrator` | `TegridyLiquidityMigrator` |
| --- | --- | --- |
| Airlock ownership rotates | `create()` reverts `InvalidProtocolOwnerBeneficiary()` — fail-closed and loud (this is probe A) | same shape: the live read follows the rotation, and a list naming the old owner reverts |
| Empty beneficiary list | rejected by `storeBeneficiaries` | accepted, and then **nobody is paid from LP fees, including you** — see below |

**One asymmetry remains and we are not hiding it.** A **zero-length** beneficiary list
still passes our `initialize`: the floor check is inside `if (beneficiaries.length > 0)`.
`migrate` then takes the `hasConstitution == false` branch and mints straight to the
launch's timelock, and no LP-fee stream exists for anyone. `Airlock.create` is
permissionless, so a third party could construct such a launch naming our migrator without
our frontend being in the loop.

Our reading is that this is not a leak of your revenue — there is no stream to take a share
of, and your auction-phase protocol fee (§7) is untouched — but it **is** a shape your
module rejects and ours does not. If you want the empty list rejected outright, say so and
we will reject it; it is a one-line change and we would rather match your invariant than
argue the edge.

---

## 7. What this changes for Doppler's fee take

A launch pays Doppler on independent legs. Only one is affected.

| Leg | Where it is computed | Effect of ask A |
| --- | --- | --- |
| **Auction-phase protocol fee** — `max(fees/20, (balance-fees)/1000)`, capped at `fees/5`, accrued to `getProtocolFees[token]`, withdrawn via `collectProtocolFees` | `Airlock._handleFees`, called at `Airlock.sol:210-211` (per §0) **before** any balance reaches a migrator | **Unaffected, structurally.** Computed in `Airlock.sol`, which we neither touch nor influence. No migrator can reduce or reroute it. |
| **Post-graduation LP fee stream** — `>= 5%` of the graduated pool's LP fees | stock: `UniswapV4Migrator.initialize` → `storeBeneficiaries`, paid by `StreamableFeesLocker` | **The floor is preserved (§6). The payout contract is not yours.** It becomes `TegridyFeeLocker`, which you have never reviewed — so you would be depending on our accounting rather than your own. That is a real transfer of trust and it does not go away by us enforcing the same percentage. |
| **Integrator fee** — `getIntegratorFees[integrator][token]` | `Airlock._handleFees` | Unaffected. Ours today, ours after. |

**And one thing with no analogue in the stock path.** `TegridyV4Hook` takes a **POL skim**
in `_afterSwap`: `polSkimBps` of the swap's *unspecified* currency, accrued to us as
ERC-6909 claims. Cited by constant name from `contracts/script/DeployV4.s.sol` (line
numbers drift; names do not):

| Param | Deploy constant | Value | Mutable after deploy? |
| --- | --- | --- | --- |
| initial POL skim | `POL_BPS` | **100 bps = 1% of swap output** | yes — by `paramAdmin`, behind a timelock |
| POL skim ceiling | `MAX_POL_BPS` | **1,000 bps = 10%** | **no — immutable at construction** |
| LP fee floor / ceiling | `MIN_FEE` / `MAX_FEE` | 500 (0.05%) / 30,000 (3%) | **no — immutable** |
| initial LP fee | `BASE_FEE` | 3,000 (0.30%) | yes — by `paramAdmin`, bounded by the two immutables |

That skim is a claim on the same trade flow your 5% is a claim on, and none of it reaches
beneficiaries. A hookless stock graduation has no skim at all. Price it into your answer
rather than discover it in a block explorer.

## 8. What the module does NOT do

| Concern | Answer |
| --- | --- |
| Can the migrator keep the launch's liquidity? | **No.** One mint, to `recipient` or to `TegridyFeeLocker`, never to itself. Residue is refunded to `recipient` in the same call. |
| Can the locker keep it? | **No.** `release(tokenId)` sends the position to the recipient recorded at lock time, after `unlockDate`. `collect` performs a `DECREASE_LIQUIDITY` of **zero** liquidity — principal is untouchable by it. |
| Can anyone call the migrator? | **No.** `initialize` and `migrate` are both `onlyAirlock`. |
| Is the migrator upgradeable or owner-controlled? | **No.** No proxy, no owner, no setters; every parameter is `immutable`. |
| Is the locker? | **Almost.** One write-once `bindMigrator`, callable by the deployer exactly once (the migrator↔locker reference is circular at construction). After it fires nothing can change it, and until it fires no lock can be registered — so an interrupted deploy leaves the locker unusable rather than hijackable. |
| Is the hook? | **No, but it has a live `paramAdmin`.** `paramAdmin` is **`TegridyV4HookAdmin`** and is **immutable on the hook**; that admin is `Ownable2Step` and every param change runs a 24h/48h timelock. Fee, skim, split, sinks and pause are reachable, all bounded by constructor immutables. The hook cannot seize or lock LP principal. The worst a captured admin **owner** can do, after the timelock elapses, is a 3% LP fee, a 10% skim, and a swap pause — liquidity removal stays open under pause. |
| What if `migrate` reverts? | `Airlock.migrate` transfers balances in **before** calling us (`Airlock.sol:216-221`, per §0), so a revert strands them in our contract. `sweepStuck(token)` is a permissionless recovery whose destination is an **immutable** `rescueRecipient` — the caller chooses nothing. |
| Refund to an ETH-rejecting recipient? | Emits `RefundFailed` rather than reverting, so a hostile recipient cannot undo a completed graduation. The dust stays recoverable via `sweepStuck`. |

## 9. What we undertake to do

Ask A is a request for a permission, so it should come with obligations. These are ours,
and we are content for any of them to be written into the grant as a condition.

1. **Keep the 5% floor at parity.** `PROTOCOL_OWNER_MIN_SHARES` stays at `5e16` with the
   live-owner read and the two matching selectors. The migrator has no setter, so changing
   it means deploying a different contract — which means coming back to you for a new
   whitelist. That is a property of the design, not a promise.
2. **Deploy once, verify, and hand you the address before it is used.** Etherscan
   verification of the migrator, the locker and the hook, so you review bytecode rather
   than a tree.
3. **No silent flip on our side.** The frontend constant that routes launches to this
   module (`frontend/src/lib/launcher/constants.ts`, `TEGRIDY_V4_MIGRATOR_ADDRESS`) is the
   zero address today, and every consumer gates on it. Until you say yes and the module is
   whitelisted, our launches keep using **your** `UniswapV4Migrator` and our own UI states
   that graduation is external. We will not set it before both are confirmed on-chain.
4. **Tell you before we change the hook's economics.** A `polSkimBps` or `baseFeePips`
   change goes through a 48h/24h timelock; we will give you notice in the same window
   rather than let you find it in a trace.
5. **Withdraw on request.** If you whitelist the module and later want it out, you already
   hold the switch — `setModuleState` back to `Disabled` — and we will not treat that as a
   dispute. We would ask only for enough notice to migrate our own UI so no launch is
   created against a module about to be disabled.
6. **Correct the record when we are wrong.** §0.1 is what that looks like.

## 10. Ask B — the BUSL-1.1 Additional Use Grant

Separate question, same party.

Doppler core is **BUSL-1.1** and we can find **no registered Additional Use Grant**. The
ENS record we understand to be the grant channel,
`doppler-license-grants.whetstoneresearch.eth`, read as unregistered on **2026-07-16**,
again on **2026-07-28**, and the last check recorded in our own repo is **2026-08-15**
(`docs/EVERYTHING_LEFT_2026_08_15.md`). **We have not re-checked it since**, and this
document does not claim to know today's state — §15 requires the operator to re-read it
immediately before sending, because sending a stale licensing claim to the licensor is a
bad way to open a licensing conversation.

On that reading, production forking of Doppler core is barred until the 2027-12-31 change
date. So we did not fork it:

- The only Doppler surfaces we depend on are the **MIT** ones: `ILiquidityMigrator`, the
  `BeneficiaryData` struct shape (**restated**, not imported — core is not vendored in our
  tree), and `TickLibrary` conventions.
- We read `UniswapV4Migrator.sol` and `StreamableFeesLocker.sol` to understand the
  Airlock's call sequence, then wrote independent implementations. `TegridyFeeLocker` is a
  clean-room pull-payment design, not a port of `StreamableFeesLocker`.
- Even our one-function `IAirlockOwner` is a local restatement rather than an import, for
  the same reason.

**If you read anything in our implementation as a derivative of the BUSL sources, tell us
and we will change it.** That offer is real; we would rather rewrite than argue.

**The actual questions:**

1. Is there a registered Additional Use Grant we have failed to find? If so, where should
   we be reading it — the ENS text record, a repo file, or somewhere else?
2. If there is none: do you intend to register one, and on roughly what horizon? A "no"
   is a useful answer. It tells us to keep building clean-room rather than wait.
3. Would you consider a **narrow, named grant** to us specifically, covering only the
   contracts we would otherwise re-derive? We are not asking for a blanket commercial
   licence.
4. Independent of any grant: is there anything in the clean-room posture above you would
   want changed?

Nothing about ask A depends on the answer. We would simply rather ask once than
re-litigate it in six months, and asking the licensor beats asking a search engine.

## 11. Audit status — unaudited

**Neither `TegridyLiquidityMigrator` nor `TegridyFeeLocker` nor `TegridyV4Hook` has been
audited by anyone.** There is no report to attach. An external audit is planned as part of
our V4 work but is **not booked**, and we are not going to imply otherwise. The scope and
trust model we would hand an auditor is `contracts/V4_AUDIT_HANDOFF.md`.

Nothing is deployed to mainnet. The addresses in §14 are blank because they do not exist.

## 12. What we still owe you before you should say yes

Our own list, unprompted. Items 1–4 are entirely within our control.

1. **An external audit report** covering the migrator, the locker and the hook. Not
   booked. This is the long one, which is why we are opening the conversation now rather
   than in three months.
2. **Deployment + Etherscan verification**, so you read deployed bytecode rather than a
   tree.
3. **A real multisig.** Today nearly every Tegridy contract is owned by a hot deployer
   EOA, `0x14898258122C0740106391E6e8E4F17F3b6d456E`. A three-Safe rebuild (Treasury
   3-of-5 / Admin 3-of-5 / Guardian 2-of-3, disjoint hardware-key signer sets) is written
   up in `docs/SAFE_REHOME_RUNBOOK.md` but **has not been executed**. Two specific
   pointers must land on those Safes at deploy time, and both are irreversible:
   - the migrator's `rescueRecipient` — an immutable constructor argument with no setter,
     the only address `sweepStuck` can ever pay. `DeployV4.s.sol` sources it from the
     `MULTISIG` env var; a wrong value there is unrecoverable.
   - `TegridyV4HookAdmin`'s **owner** — the hook's `paramAdmin` is that admin contract and
     is immutable, so the Safe's control point is the admin's `Ownable2Step` ownership,
     transferred in the deploy script and requiring `acceptOwnership()`.
4. **The hook's standing initializer allowance.** `TegridyV4HookAdmin` must run
   `proposeInitializerAllowed(migrator, true)` → **48h** (`INITIALIZER_ALLOW_DELAY`) →
   `executeInitializerAllowed()`. Without it `migrate()` reverts at
   `poolManager.initialize` with `PoolNotAllowed()` — and because `Airlock.migrate` is
   permissionless and has **already moved the funds**, that revert strands a real launch's
   liquidity. This is an operational failure we would be inflicting on your users, so it
   belongs on this list rather than in our runbook.

## 13. Verify everything above yourself

Nothing here needs to be taken on faith.

### On-chain (`cast`)

```bash
RPC=https://ethereum-rpc.publicnode.com
AIRLOCK=0xde3599a2ec440b296373a983c85c365da55d9dfa
V4MIG=0x0820a4d0173c17ece283f7bdaaf0f8876eb205f5

# The owner this petition is addressed to, and its Safe shape.
cast call $AIRLOCK "owner()(address)" --rpc-url $RPC
OWNER=<the address that returns>
cast call $OWNER "VERSION()(string)"      --rpc-url $RPC
cast call $OWNER "getThreshold()(uint256)" --rpc-url $RPC
cast call $OWNER "getOwners()(address[])"  --rpc-url $RPC

# The module-state value §2 asks for. The stock V4 migrator returns 4.
cast call $AIRLOCK "getModuleState(address)(uint8)" $V4MIG --rpc-url $RPC

# Probe C from §6: the contract itself reports the 5e16 minimum.
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

If `owner()` no longer returns `0x21E2ce70511e4FE542a97708e89520471DAa7A66`, then §2, §6
and §14 are all stale at once. Stop and fix the document.

### In the tree we hand you

Do not trust a branch name — including ours. Whatever tree you are given, confirm the §6
fix is actually in it:

```bash
# Must print a line. If it prints nothing, the fix §6 describes is NOT in this tree.
grep -n 'PROTOCOL_OWNER_MIN_SHARES' contracts/src/v4/TegridyLiquidityMigrator.sol

# The five floor tests §5 names.
grep -c '^    function test' contracts/test/v4/TegridyLiquidityMigrator.t.sol   # 21
grep -n 'ProtocolOwner\|acceptsExactlyTheFloor' contracts/test/v4/TegridyLiquidityMigrator.t.sol

# Run them.
cd contracts && forge test --match-contract TegridyLiquidityMigrator
```

Doppler's deployed sources are Etherscan-verified at the addresses above; every
`Airlock.sol:NNN` / `UniswapV4Migrator.sol:NNN` reference in this document is to that
verified source as read on 2026-07-31, not to a fork, and not re-checkable from our repo
(§0).

## 14. Addresses / contact

| Item | Value |
| --- | --- |
| Airlock | `0xde3599a2ec440b296373a983c85c365da55d9dfa` |
| Airlock owner — this petition's recipient | `0x21E2ce70511e4FE542a97708e89520471DAa7A66` — Safe 1.4.1, **3-of-6** (read 2026-07-31; re-read before sending) |
| `TegridyLiquidityMigrator` | **not deployed.** Deploy + verify, then fill in. |
| `TegridyFeeLocker` | **not deployed.** |
| `TegridyV4Hook` / `TegridyV4HookAdmin` | **not deployed.** |
| Deployer — current owner of nearly everything, see §12.3 | `0x14898258122C0740106391E6e8E4F17F3b6d456E` |
| Integrator address for existing launches | `0xD355A072d6bBbA275DBD83A3149f6347b06d1051` (EOA, deliberately — §3) |
| Audit report | **none exists** |
| Venue decision record | `docs/GRADUATION_VENUE_DECISION.md` |
| Contact | _(operator to supply)_ |

---

## 15. Operator checklist before sending

In order. Steps 1–3 are non-negotiable; the rest are what turns a serious petition into an
approvable one.

- [ ] **Re-run every command in §13's on-chain block.** If `Airlock.owner()` changed, §2,
      §6 and §14 are stale together. If any probe result differs, fix the document rather
      than the expectation.
- [ ] **Re-check the BUSL grant channel** (`doppler-license-grants.whetstoneresearch.eth`)
      and update §10's date. Do not send a licensing claim four days old to the licensor.
- [ ] **Decide what tree you are handing them, and run §13's in-tree block against it.**
      If `grep PROTOCOL_OWNER_MIN_SHARES` prints nothing, you are about to repeat the exact
      error §0.1 records. Prefer a tag or an immutable archive over a moving branch, and
      state the exact ref in the covering note — never a bare branch name.
- [ ] Fix `frontend/src/lib/launcher/airlock.ts:107` — "a Tegridy multisig" on the
      integrator address (§3). `config.ts` is already correct; make the two agree.
- [ ] Confirm §7's parameter table still matches `DeployV4.s.sol`'s `POL_BPS`,
      `MAX_POL_BPS`, `MIN_FEE`, `MAX_FEE`, `BASE_FEE`.
- [ ] Decide the §6 empty-list question: leave it as an open offer, or close it before
      sending. Either is defensible; leaving it undecided in the document is not.
- [ ] **Execute `docs/SAFE_REHOME_RUNBOOK.md`** before deploy, so `rescueRecipient` and
      `TegridyV4HookAdmin`'s owner land on Safes rather than the deployer EOA (§12.3).
      Both are effectively one-shot.
- [ ] Book the external audit, or say plainly in the covering note that it is not booked.
- [ ] Fill in a contact in §14.

Sending is a human action. Nothing in this repository sends it.

---

## 16. Covering note (paste into email / Discord)

> Subject: Module-whitelist review request + BUSL grant question — custom `LiquidityMigrator` (Tegridy Farms / memetic.fun)
>
> Hi — we're Tegridy Farms (memetic.fun), an existing Doppler integrator on Ethereum
> mainnet. We already launch through the canonical Airlock with the stock modules
> (`DopplerERC20V1Factory` / `UniswapV4Initializer` / `UniswapV4Migrator`), integrator
> `0xD355A072d6bBbA275DBD83A3149f6347b06d1051`.
>
> Two things, one message.
>
> **1 — A module whitelist, on deploy.** We've written a `LiquidityMigrator` of our own,
> `TegridyLiquidityMigrator` (`contracts/src/v4/TegridyLiquidityMigrator.sol`), so completed
> auctions graduate into a canonical Uniswap V4 pool carrying our hook instead of a hookless
> one. The ask is one call from the Airlock owner:
> `setModuleState([migrator], [4])` — `ModuleState.LiquidityMigrator`, the same state your
> own `UniswapV4Migrator` reports. **It isn't deployed yet**, so this is a request to
> whitelist on deploy against a bytecode you'd verify first, not to whitelist something
> live. Until it lands, `Airlock.create` reverts `WrongModuleState` for any launch naming
> it, so it's the long pole rather than a last step.
>
> The LP position still goes to the launch — its own timelock, or a fee locker that pays the
> launch's declared beneficiaries and releases the position to the launch at unlock. We
> never hold it. And to be precise rather than flattering: that's a **time-locked** position
> in a locker **we wrote**, which is a weaker guarantee than a burned one.
>
> The obvious objection, which we'd rather raise than have you find: **your mandatory
> ≥5%-to-Airlock-owner beneficiary floor lives inside `UniswapV4Migrator.initialize`, not
> inside `Airlock.sol`** — we verified it live (owner absent →
> `InvalidProtocolOwnerBeneficiary()`; owner at 4% →
> `InvalidProtocolOwnerShares(5e16, 4e16)`; the selector is absent from the Airlock's own
> bytecode). So a custom migrator removes that floor unless it reimplements it. **Ours
> reimplements it** — live `Airlock.owner()` read, `>= 5e16`, duplicate entries summed, the
> same two error selectors, five tests including an owner rotation followed mid-test. One
> asymmetry remains and is in the write-up: a zero-length beneficiary list still passes
> ours, where yours rejects it. Say the word and we'll reject it too. Your auction-phase
> protocol fee is untouched either way — it's computed in `Airlock.sol` before anything
> reaches a migrator.
>
> We'd also flag, unprompted, that our hook takes a POL skim on swap output — 1% initially,
> hard-capped at 10% by a constructor immutable — which has no analogue in a stock hookless
> graduation. And that the payout contract on the streaming leg becomes ours, which you have
> never reviewed. Both belong in your answer rather than in a later trace.
>
> Honest status: nothing deployed, nothing audited, and our contracts are still owned by a
> deployer EOA rather than the multisig we've specced. All of that is on us before this is a
> real request. **What we're asking now: is a custom `LiquidityMigrator` something you'd
> consider at all, and if so, what would have to be true for the answer to be yes?** We're
> happy for any grant to be conditional on a specific verified address.
>
> **2 — The BUSL Additional Use Grant.** Separate question. We can't find a registered
> Additional Use Grant for Doppler core — `doppler-license-grants.whetstoneresearch.eth`
> read as unregistered every time we've checked. We've assumed that means no production
> forking before the change date, so we didn't fork: we depend only on the MIT surfaces
> (`ILiquidityMigrator`, the `BeneficiaryData` shape restated rather than imported,
> `TickLibrary` conventions) and wrote clean-room implementations. Is there a grant we've
> missed, do you intend to register one, and would you consider a narrow named grant? A
> plain "no" is genuinely useful — it tells us to keep building clean-room instead of
> waiting. And if you read anything of ours as a derivative of the BUSL sources, tell us and
> we'll change it.
>
> Full write-up attached, including the exact `cast` commands so you can reproduce every
> claim rather than take our word for it — plus a one-line `grep` to confirm the 5%-floor
> fix is really in the tree we hand you.
>
> Thanks,
> — [operator]
