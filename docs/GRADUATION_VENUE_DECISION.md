# Where a launch graduates

**Decision record. Written 2026-08-19, at the point the choice became load-bearing on an
outside party rather than on us.**

Sibling to [`CURVE_FORK_EVALUATION.md`](CURVE_FORK_EVALUATION.md), which does the same job
for the Solana bonding curve, and to
[`solana/tegridy-amm/TEGRIDY_FORK.md`](../solana/tegridy-amm/TEGRIDY_FORK.md), which does it
for the AMM. There was no counterpart for the **EVM graduation venue** until now.

---

## The decision

**A completed Doppler auction graduates into a canonical Uniswap V4 pool carrying
`TegridyV4Hook`, reached by replacing the Airlock's `LiquidityMigrator` module with
`TegridyLiquidityMigrator`.**

Not into the protocol's own V2-fork AMM. Not into a new venue contract. The pool is
Uniswap's; the hook and the migrator are ours.

Decided by the operator. This document records the alternative and the price, because a
decision with no recorded alternative gets re-litigated the first time the external
dependency stalls — and this one has an external dependency that can say no.

## Why it needed writing down today

The choice used to be internal. It stopped being internal the moment it resolved to the V4
route, because that route routes through a permission we do not hold:

> `Airlock.create` validates every module named in a launch's params and reverts
> `WrongModuleState` for any module the Airlock owner has not whitelisted. A custom
> `LiquidityMigrator` therefore cannot be used — cannot even be *named in a launch* —
> until Whetstone's Airlock owner calls `setModuleState(migrator, 4)`.

So the venue decision converts directly into a petition to a third party
([`WHETSTONE_MIGRATOR_PETITION.md`](WHETSTONE_MIGRATOR_PETITION.md)), and a petition needs
a stable rationale behind it. If the rationale is still being argued internally, the
petition is premature.

## The two candidate shapes

Only two were ever real. Both graduate a launch into a venue the protocol has some claim
on; they differ in **whose AMM the liquidity lands in**.

### Shape A — hooked canonical V4 pool, via a custom Airlock module  ✅ CHOSEN

```
Doppler auction completes
   ↓  Airlock.migrate  (permissionless; transfers both legs in FIRST, then calls us)
TegridyLiquidityMigrator                     contracts/src/v4/TegridyLiquidityMigrator.sol
   ↓  one full-range mint into a canonical Uniswap V4 pool
PoolKey{ hooks: TegridyV4Hook, fee: DYNAMIC_FEE_FLAG }
   ↓  position NFT
constitution declared?  →  TegridyFeeLocker  (pull-payment, releases at unlockDate)
no constitution?        →  the launch's own timelock (Airlock-supplied recipient)
```

- The AMM is **Uniswap's canonical PoolManager**. We add a hook; we do not run an exchange.
- Revenue reaches the protocol two ways: the fee constitution's own lines on the streaming
  leg, and the hook's `_afterSwap` POL skim (1% of swap output initially, hard-capped at
  10% by a constructor immutable).
- **Requires** Whetstone to whitelist the module.

### Shape B — graduate into the protocol's own V2-fork AMM  ❌ REJECTED

```
Doppler auction completes
   ↓  Airlock.migrate
<a V2-shaped LiquidityMigrator that does not exist>
   ↓
TegridyPair on TegridyFactory 0xa24C7287eC56A7DEFDc70033803451240e267a52
```

This is the shape the own-venue thesis originally implied, and it is still the shape one
frontend string describes (see *Loose ends*). It captures more per trade — the whole pool
fee, not a share of someone else's — and it needs the same Whetstone whitelist, because it
is still an Airlock module.

### The comparison that decided it

| | **A — hooked V4 pool** | **B — own V2-fork AMM** |
| --- | --- | --- |
| `ILiquidityMigrator` implementations in the tree | **1** — `TegridyLiquidityMigrator.sol`, 548 lines | **0**. No contract in `contracts/src/` targets `TegridyFactory` from a migration path. |
| Supporting contracts written | `TegridyFeeLocker.sol` (324), `TegridyV4Hook.sol` (467), `TegridyV4HookAdmin.sol` | none |
| Tests | **79** across three Foundry files — 21 migrator, 19 locker, 39 hook | none |
| AMM code we would be responsible for | none — canonical PoolManager, audited upstream, treated as trusted | a V2 fork we already own, plus a new migration path into it |
| Afterlife farming | works today: `TegridyBoostedLPStaker` escrows V4 PositionManager NFTs and binds one immutable `allowedPoolId` per instance — **any** V4 pool, canonical or hooked | would need a V2-LP-shaped equivalent |
| Needs the Whetstone whitelist | **yes** | **yes** — same gate, no advantage |
| Per-trade capture | a share of a Uniswap pool's fee, plus the POL skim | the whole pool fee |
| New unaudited surface at the AMM layer | zero | the whole graduated-pool AMM path |

**Shape A won because it is already written and already tested, and Shape B is not written
at all.** That is the entire argument, and it is deliberately unglamorous. B captures more
per trade; A exists. Given that both need the identical external permission, choosing the
unwritten one would buy a larger revenue share with an unbounded amount of new unaudited
fund-holding code and a second audit — against a treasury that has not booked the first one.

Two secondary reasons, both checkable rather than strategic:

1. **A adds no AMM-layer attack surface.** Shape A's custom code sits *beside* the
   canonical PoolManager (a hook and a migrator); Shape B's would sit *underneath* the
   liquidity. The house rule is minimal attack surface, and the difference here is not
   marginal.
2. **The afterlife already works on canonical pools.** `TegridyBoostedLPStaker` needs no
   Whetstone approval and no custom hook to farm a graduated pool. So the marginal thing
   Shape A buys over doing nothing is the hook's economics — not the ability to have a day
   two, which we already have.

### What was NOT a candidate

**Keeping the stock `UniswapV4Migrator` forever** is not a third shape — it is the
**fallback**, and it is what runs today. It is recorded below rather than here because it is
where we land if the decision cannot be executed, not a venue we chose.

## Accepted risks

Named, with the cost, so nobody is surprised later.

### 1. Whetstone can simply decline — and this is not a risk we can retire

`setModuleState` is `onlyOwner` on their Airlock. There is no permissionless path, no
workaround, and no amount of engineering on our side that converts a no into a yes. Our
own petition puts the objection on the table unprompted (their mandatory 5% floor lives
inside the module we are replacing), which is the honest way to ask and also the way that
invites a no.

**Accepted because the fallback is the status quo, not an outage.** See *Fallback* — the
launcher is live today on the stock path and no user-visible promise depends on the answer.
That is the property that makes this a safe thing to ask for.

**Not accepted as an excuse to pre-wire it.** `TEGRIDY_V4_MIGRATOR_ADDRESS` in
`frontend/src/lib/launcher/constants.ts` is the zero address, every consumer gates on
`isDeployed()`, and the venue module reports `ownership: 'external'` with a disclosure
sentence while it stays zero. It must not be set on the strength of a friendly reply — only
after the module is whitelisted **and** the hook's standing initializer allowance is live,
both confirmed by an on-chain read.

### 2. The LP is time-locked in a locker we wrote, not burned

This is the weakest trust claim in Shape A and the one most likely to be overstated by
someone summarising it.

When a launch declares a fee constitution, the position NFT is minted to
`TegridyFeeLocker`. The locker collects fees permissionlessly, credits beneficiaries
pull-style, and at `unlockDate` **releases the position to the recipient recorded at lock
time**. `unlockDate == 0` means permanent — no release path exists — but a timed lock does
expire, and after it expires the recipient can withdraw.

So:

| Claim shape | Sayable? |
| --- | --- |
| that the LP is escrowed, and that its fees stream to the published beneficiaries | yes |
| that no party can move the principal during the lock | yes — `collect` is a `DECREASE_LIQUIDITY` of **zero** liquidity |
| any word implying destruction or permanence of the lock | **no**, except where `unlockDate == 0` |

A burn is verifiable by anyone with an RPC and needs no trust in us. A time lock in our own
contract is a claim about a contract that has never been audited. **Accepted** — burning
the LP would forfeit the fee-streaming mechanism that the whole published fee constitution
depends on — but accepted on the condition that no surface ever calls it burned or
irreversible. `frontend/src/lib/launcher/graduation/venue.ts` already carries that
constraint in code (`LpDisposition` distinguishes `time-locked-escrow` /
`permanently-locked` / `burned`, and its comment records that calling the Doppler path
"burned" would be false); it must keep doing so for our own path.

### 3. Whetstone's fee floor now depends on our code, not theirs

Even with the floor reimplemented at parity, the *payout* contract on the streaming leg
becomes `TegridyFeeLocker` rather than `StreamableFeesLocker`. Their 5% stops being
enforced by their own accounting and starts being enforced by ours. **Accepted, and
disclosed to them in the petition rather than left to be discovered** — but it is a real
transfer of trust and it is the strongest reason a careful reviewer would say no.

### 4. Three contracts go live unaudited unless the audit lands first

`TegridyLiquidityMigrator`, `TegridyFeeLocker` and `TegridyV4Hook` are tested and
**unaudited**; the external audit is not booked. The migrator sits in a path where
`Airlock.migrate` transfers a real launch's liquidity in **before** calling us, so a revert
in our code strands funds rather than merely failing. `sweepStuck` exists for exactly that,
and its destination is an immutable `rescueRecipient`.

**Accepted only as a sequencing risk, not a shipping one.** The petition tells Whetstone
plainly that nothing is audited, and asks them to make any grant conditional. The frontend
gate stays zero regardless.

### 5. The POL skim has no analogue in the stock path

`TegridyV4Hook._afterSwap` skims `polSkimBps` of the swap's unspecified currency — 1%
initially (`POL_BPS`), ceiling 10% (`MAX_POL_BPS`, immutable). A hookless stock graduation
skims nothing. **Accepted and disclosed** in the petition; the alternative was to let a
third party find it in a trace, which would have cost more than the disclosure does.

## Fallback if Whetstone refuses

There is one, it is already running, and it needs no engineering to reach. That is what
makes ask A a safe thing to attempt.

1. **Do nothing and stay on the stock path.** `TEGRIDY_V4_MIGRATOR_ADDRESS` is zero, so
   `airlock.ts` resolves Doppler's own `uniswapV4Migrator` and launches graduate into a
   hookless canonical V4 pool with `StreamableFeesLocker` beneficiaries — exactly as they
   do today. **Nothing breaks on a no**, because nothing was ever switched. The venue
   module's disclosure sentence already says graduation is external, so no published claim
   becomes false either.
2. **Keep the afterlife, which never needed permission.** `TegridyBoostedLPStaker` escrows
   V4 PositionManager NFTs and binds one immutable `allowedPoolId` per instance. It farms
   a **canonical** graduated pool as well as a hooked one. Boosted LP farming, gauge
   application, and the rest of the day-two stack survive a refusal untouched.
3. **What is actually lost:** the hook on graduated pools — JIT protection for their LPs,
   bounded dynamic fees, and the POL skim. Real, and bounded. It is a revenue and
   product-differentiation loss, not a functional one.
4. **What we do NOT do on a refusal.** Two temptations, both refused in advance:
   - **Do not reach for Shape B.** It needs the *same* whitelist. A refusal is a refusal of
     custom modules, not of V4 specifically, so pivoting to the own-AMM shape buys nothing
     and costs an unwritten migrator plus an audit.
   - **Do not self-host an Airlock.** Doppler core is BUSL-1.1 with no Additional Use Grant
     we can find (which is why the petition carries a second, separate ask about the grant).
     Standing up our own Airlock would be the production fork the licence bars.
5. **The long-stop.** BUSL-1.1's change date converts Doppler core to an open licence at
   the end of 2027, and v4-core's own BUSL→MIT flip is earlier. A refusal today is not
   permanent — it is a delay whose end date is written into someone else's licence. That is
   also the strongest argument for asking now: the answer costs nothing to obtain and
   informs three months of sequencing.

## If this gets reopened, these are the facts to re-check first

Shape A's whole case is "already written and tested." That claim decays. Re-establish it
before arguing from it:

```bash
# Exactly one ILiquidityMigrator implementation, and it is the V4 one.
grep -rl 'ILiquidityMigrator' contracts/src/

# The floor fix the petition stakes its credibility on.
grep -n 'PROTOCOL_OWNER_MIN_SHARES' contracts/src/v4/TegridyLiquidityMigrator.sol

# The 77.
for f in contracts/test/v4/TegridyLiquidityMigrator.t.sol \
         contracts/test/v4/TegridyFeeLocker.t.sol \
         contracts/test/v4/TegridyV4Hook.t.sol; do
  printf '%s ' "$f"; grep -c '^    function test' "$f"
done

# Still gated off, and still zero.
grep -n 'TEGRIDY_V4_MIGRATOR_ADDRESS' frontend/src/lib/launcher/constants.ts
```

If the first command returns more than one file, Shape B stopped being hypothetical and
this decision needs re-running rather than re-reading.

## Loose ends this decision creates

Recorded, not fixed here.

- **`frontend/src/lib/launcher/graduation/venue.ts` still names the wrong venue.**
  `plannedVenueMigrator()` returns
  `venue: 'Tegridy DEX (TegridyFactory 0xa24C…7a52)'` — that is **Shape B**, the rejected
  one. The migrator this decision chose graduates into a canonical Uniswap V4 pool carrying
  `TegridyV4Hook`, not into `TegridyPair`. The string is user-visible planning copy, it
  currently describes a venue that will not be built, and it is the last place in the tree
  where the rejected shape is still asserted as the plan. Fix the string; do not fix it by
  changing the decision.
- **Two Solana own-venue programs were deployed and closed** (2026-08-08 → 2026-08-13,
  per `docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md`). That was the Shape-B-equivalent bet on
  the other rail, and it is the closest thing to evidence either way. It is not cited above
  as an argument, because the Solana closure had its own causes — but anyone reopening this
  should read it before proposing that the protocol run its own graduation AMM.
- **The `unlockDate == 0` permanent-lock path is the one shape that would let us make a
  burn-strength claim** without burning. Nothing depends on it today. If a future launch
  tier wants "irreversible", that is the mechanism, and it needs its own decision about who
  may choose it.

---

# Addendum 2026-08-22 — the decision extends to Robinhood Chain (4663), unchanged

The owner directed that Doppler launches on Robinhood Chain "graduate to us." That
directive is SATISFIED BY SHAPE A and does not reopen this decision: the venue that is
"us" remains the hooked canonical V4 pool, and every argument in the table above carries
over to 4663 — same written-and-tested module, same zero AMM-layer surface, same external
gate. Shape B stays rejected on 4663 for the same reasons it was rejected here, plus one
this chain adds: the 4663 leg's TegridyFactory is not even deployed yet, so B would be an
unwritten migrator into an undeployed venue.

What made the extension possible had to be verified first, and was (2026-08-22, each read
against the chain itself — provenance in `contracts/script/robinhood/RobinhoodChainConfig.sol`):

- The **full canonical V4 substrate is live on 4663**: PoolManager
  `0x8366…0951` (48,021 B — and the SAME address Doppler's UniswapV4Initializer reports),
  PositionManager `0x58da…4fA7` (whose `poolManager()` returns that PoolManager —
  cross-bound, not co-listed), Permit2, Universal Router; listed by Uniswap's own
  deployments directory.
- Whetstone's stock migrators on 4663 CANNOT graduate to us: `UniswapV2MigratorSplit`
  hardwires Whetstone's own V2 factory (`factory()` = `0x8bcE…937f`, read on-chain), and
  there is no `UniswapV4Migrator` / no V1 locker on the chain — so "graduate to us" via
  stock modules is impossible by config, on any shape.
- The **4663 Airlock owner is the same 3-of-6 Safe as mainnet and Base** (byte-identical
  owner set; no guard, no timelock — verified). One petition relationship covers every
  chain; the ask is one `setModuleState([migrator],[4])` Safe tx per chain.

The execution artifact is `contracts/script/robinhood/DeployRobinhoodGraduationStack.s.sol`
(+ its test suite): the SAME five contracts as mainnet's `DeployV4.s.sol` — hook admin,
mined `TegridyV4Hook`, `TegridyV4SwapRouter`, `TegridyFeeLocker`, `TegridyLiquidityMigrator`
— against the verified 4663 substrate constants, minus `TegridyBoostedLPStaker` (TOWELI
rewards + veTOWELI boost are mainnet-only; afterlife farming on 4663 is a separate decision
with its own reward token). Policy constants are byte-identical to mainnet: same economics
or none.

Sequencing note the mainnet path does not have: the petition for 4663 (see
`docs/WHETSTONE_MIGRATOR_PETITION_4663.md`) should ride WITH the mainnet petition, not
ahead of it — one conversation, two chains, the same Safe. And the whitelist-precedent
reality found while verifying this addendum applies to both: **no third-party module has
ever been whitelisted on any of the three Airlocks** — every state-4 migrator is
Whetstone-authored. The realistic petition outcome may be Whetstone blessing or co-owning
the module (their `src/extensions/CustomUniswapV3Migrator` shows they build custom
migrators for partner venue shapes). The fallback remains the fallback: stock modules run
until the whitelist lands, and nothing above changes what launches do today.
