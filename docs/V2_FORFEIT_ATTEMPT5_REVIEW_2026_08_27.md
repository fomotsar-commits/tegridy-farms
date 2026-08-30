# v2 distributor — attempt 5 (delete the forfeit): review outcome

**Branch `fix/v2-delete-forfeit`, commit `afa10262`.** Five adversarial lenses, then a separate
adjudicator per claim required to reproduce it independently or kill it.

**17 claims adjudicated: 12 confirmed, 5 killed. Of the 12 confirmed, ELEVEN are PRE-EXISTING on
`mvp-launch` — byte-identical there — and ONE is attributable to this change.**

That is a materially different result from attempts 1–4, each of which was refuted on defects it
introduced. Attempt 5 was measured against trunk on every confirmed finding and is **strictly better
or identical everywhere**. It is still not merged, because the pre-existing critical below sits in
the same function it touches and the two should land together.

`StreamingRevenueDistributor` is deployed nowhere — no `addresses.json` entry, no
`lib/constants.ts` constant. None of this is live money.

---

## 1. The one finding that belongs to this change — and it is a documentation defect

`_updateReward`'s new comment said the stale-mirror trade "costs the pool a bounded amount" and
"fails toward the staker rather than away from them". **An adjudicator measured both and both were
false**, so they are corrected in-source rather than deleted:

- It does not cost *the pool*. A frozen mirror keeps its share of the stream, so the cost falls on
  every **other** staker — measured at **~17.6% of entitlement per frozen peer of equal weight**.
  It fails toward the account being read and **away from everyone else**.
- The blast radius is wider than "restakers". The comment said a broken restaking read "holds its
  own stakers' mirrors stale". Measured: while `restakingContract` is wired it freezes **every**
  account whose escrow power reads zero — a set dominated by exited and expired **plain** stakers
  who never touched restaking. `_mirrorPower`'s re-ask does not rescue them; it is gated on
  `restakingContract == address(0)`.

Read next to `_mirrorPower`'s docblock — which names "froze every expired plain-staker position" as
the thing the re-ask exists to prevent — a reader assembles the two paragraphs and concludes the
freeze is fixed generally. It is fixed only in the unwired case. Both blocks now say so.

**Two corrections the adjudicator made in the change's favour**, recorded because the first draft of
this finding overstated it:

- **"Accruing indefinitely" is false.** One ordinary permissionless `sync` after the dependency
  heals restores `effectiveBalanceOf` and `totalEffectiveSupply` exactly. Harm is bounded by outage
  duration intersected with the schedule.
- **It is not caller-chosen.** A reviewer swept every permissionless entry point trying to trigger
  it on demand and could not.

---

## 2. ⛔ The pre-existing critical — the two power legs must be ADDITIVE

`_tryEffectivePower` short-circuits: `if (power > 0) return (true, power);`. The restaking leg is
consulted **only** when the staking leg reads zero. So an account holding **both** a live stake and
a restake is mirrored at the staking leg alone, and the restaked weight is silently discarded.

**This diverges from v1's audited additive aggregation and from this repo's own `VotePowerOracle`,
both of which sum the two sources.**

- **No attacker needed.** `TegridyStaking.stake` gates on `userTokenId[msg.sender] == 0`, and
  restaking transfers the NFT out and clears that pointer — so `stake → restake → stake` is a
  permitted flow that leaves one veNFT owned and one custodied. Measured against the **real**
  contracts (not mocks): staking leg 228.45e18, restaked leg 45,690e18, true total 45,918.45e18,
  **mirror written 228.45e18 — 99.50% of the account's weight outside the accrual set.**
- **`isSynced` returns true on it**, certifying the truncated figure. Its own NatSpec calls that
  outcome "the fabricated-data failure this protocol gates against".
- **It is also weaponisable.** A stranger can gift a restaker a live veNFT — no consent needed,
  since `StakingRewardLib` gates only on `userTokenId[to] != 0` and a restaker's is zero — then call
  the permissionless `sync(victim)` to collapse their mirror. Reproduced: **2,816× collapse**, and
  **31.478 ETH of a 70 ETH schedule** moved from the restaker to the other staker, matching to
  within 1.9e4 wei — a pure inter-account transfer.

**The fix is validated by execution**, in a scratchpad copy: making the two legs additive neutralises
the attack (mirror 128,735.69e18; 35.0056 ETH vs 34.9944 ETH against a 35/35 control). The small
surplus is correct — the gifted dust genuinely is hers. Disjointness holds by construction, so
summing cannot double-count.

**Keeping the forfeit would not have helped here.** Trunk's numbers on this attack are byte-identical.
This is no argument for reinstating it.

---

## 3. A written claim that is false, and is retracted

The commit message for `afa10262` says: *"Nothing reachable from a permissionless call can reduce
`rewards`, and no mechanism moves value between accounts at all."*

- The first half **holds** — `rewards[]` is never decremented; already-crystallised accrual is safe.
- The second half is **false**. Permissionless `sync` mutates `effectiveBalanceOf` and
  `totalEffectiveSupply`, which reassigns all *future* stream share. 31.478 ETH moved between
  accounts in the adjudicator's run.

The honest form: *nothing reachable from `sync` can reduce `rewards[]` or increase
`totalForfeitedToPool`* (the latter no longer exists) — **but the mirror it does write determines
future share, and that is a value-moving surface.** This is the third time in this contract's history
that a confident header sentence has outrun the code. The mirror is the recurring reason.

---

## 4. Killed on adjudication — do not re-file

- **`sync`/`syncMany` bypass the staking kill switch.** Mechanically true and pre-existing, but
  refuted as a defect of this change.
- **Donated WETH is unrecoverable.** The literal state reproduces; every load-bearing part of the
  harm argument failed.
- **A claim whose requested fix was itself a money bug.**
- **A claim whose headline numbers reproduced to the wei but which was not a defect of `afa10262`.**
- **A claim the claimant had already self-labelled undemonstrated**, which survived that label.

---

## 5. What attempt 6 is, and what it is not

It is **not** another attempt at a forfeit. Deleting it is upheld: no confirmed finding argues for
reinstating it, and one explicitly argues against.

The remaining work in this function is:

1. **Make `_tryEffectivePower` additive** (§2). Highest value, validated fix, matches v1 and
   `VotePowerOracle`, pre-deploy.
2. **Decide the wired-restaking freeze** (§1). The re-ask rescues only the unwired case. Options are
   to extend it, or to accept and document the bounded peer cost. Both are defensible; picking one
   silently is not.
3. **Stop the mirror being the trust root.** Three refutations in this contract now trace to the same
   place: it mirrors an external escrow, while the Synthetix design it is modelled on owns an
   authoritative balance. `docs/CONTRACT_PROVENANCE_AUDIT_2026_08_26.md` §6 flagged exactly this.
   That is a design question, not a patch.

---

## Method note, for whoever runs the next one

The brief told every agent that `afa10262` was checked out in the main working tree. **It was not** —
three sessions share that checkout and the branch pointer moved twice during the run. Several
adjudicators caught this themselves, extracted the commit read-only with `git show` into isolated
forge projects, and said so. Their results are the trustworthy ones. Any future review of an
uncommitted or unchecked-out change should hand agents an explicit `git show <sha>:<path>` recipe
rather than an assertion about the working tree.
