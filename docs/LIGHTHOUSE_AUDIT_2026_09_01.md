# Lighthouse staking — adversarial audit, 2026-09-01

31 specialist lenses over the whole staking money path (EVM contract, Solana /
Streamflow rail, infra). **145 findings raised, 100 refuted by agents whose job
was to kill them, 45 survived.** Below is what survived, grouped by root cause —
many separate findings are the same bug seen through different lenses.

## VERDICT

**Do not let anyone stake on the EVM ladders until C1 is fixed and redeployed.**
The contract's single load-bearing promise — that a reward payout can never
touch principal — is false, and it is *proven*, not argued (see C1).

**Exposure today is zero.** All six live ladders return `totalSupply() == 0`:
PEPE `0xdC0B34cE…329c` (Ethereum), QR `0xdcc3a95A…c8E3`, MFER `0x7288DbF4…6273`,
BNKR `0xe0A152EB…3178`, DRB `0xB62BaD16…83F1`, JBM `0xA0D43eF3…6D93` (Base).
Nobody has deposited. This is *fix before the first deposit*, not an incident.

---

## C1 — CRITICAL, PROVEN: rewards are paid out of other stakers' principal

`contracts/src/LighthouseLadder.sol:264` (`withdrawPosition`) and `:277`
(`earlyExit`) both run:

```
_close(id, p);            // _totalSupply -= p.amount
_payRewards(msg.sender);  // caps at balanceOf(this) - _totalSupply
stakingToken.safeTransfer(msg.sender, p.amount);   // principal leaves HERE
```

`_close` (`:356`) debits `_totalSupply` **while the principal is still in the
contract**. `rewardSurplus()` (`:178-181`) is `balanceOf(this) - _totalSupply`.
So the cap `_payRewards` reads (`:369`) is over-stated by exactly the exiting
staker's own deposit. These are same-token pools, so the two really are the same
tokens.

**Proof — `contracts/test/vendor/LadderOrderingPoC.t.sol`, 4/4 passing:**

- `test_00_precondition_isReachable` — the overcommitted state (owed > surplus)
  is reachable through the contract's OWN guard, no cheatcodes: sum owed 120,
  true surplus 60.
- `test_01_EXPLOIT_shippedOrderBreaksSolvency` — Bob exits and is paid **100
  when the true surplus was 60**. Overpay of 40 straight out of principal. Pool
  balance 960 against `_totalSupply` 1000. **Alice is short 40 on her 1000.**
- `test_02_COUNTERFACTUAL_reorderHoldsTheInvariant` — with the two lines
  swapped, Bob is paid exactly 60, the remaining 40 stays **owed (deferred, not
  stolen)**, balance == totalSupply == 1000, **Alice recovers her full 1000**.
- `testFuzz_03` (256 runs) — with a single well-funded notify the ordering is
  latent. That is why nothing caught it: it needs the overcommitted state that
  C2 makes reachable.

**FIX** — swap two lines in each function so the cap is read while
`_totalSupply` still counts the exiting principal. `updateReward` has already
checkpointed `rewards[]` in the modifier, so nothing depends on the old order:

```
_payRewards(msg.sender);
_close(id, p);
```

`contracts/test/vendor/LighthouseLadderFixed.sol` is the corrected copy the
counterfactual runs against. Deployed bytecode cannot be patched — this needs a
redeploy and a repin of the six registry addresses.

## C2 — CRITICAL: `notifyRewardAmount`'s guard double-counts unclaimed rewards

`:323` bounds a whole new emission period by `rewardSurplus()`. But rewards that
have accrued and not yet been claimed are physically still in `balanceOf(this)`
and are not in `_totalSupply` — so they are counted as **fresh budget**. The
same tokens can be pledged to two seasons, and a notify with *zero* new funding
is accepted. This is the reachable precondition for C1.

**FIX** — track the liability. Add `uint256 public totalOwed`, increment it in
`updateReward` by `earned(account) - rewards[account]`, decrement it in
`_payRewards`, and subtract it in both guards.

## C3 — CRITICAL: the pool authority is a devnet bot's hot key inside OneDrive

`GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9` — the authority over both live
BAYLA pools — is reported to be the **SolanaDevnetFaucet bot's main wallet**,
with its 64-byte secret in **two plaintext files inside the OneDrive sync root**
(`faucet/main-keypair.json` and `faucet/wallets.json`), and an **enabled
scheduled task runs a cloud-synced script from that folder every 2 hours**.

**FIX** — rotate the authority to a hardware or air-gapped key via
`change_authority` on each program; move the faucet directory out of the sync
tree; delete the scheduled task. *(Agent-reported. I have not opened those files
myself — verify first, but treat as true until disproven.)*

## C4 — CRITICAL: `--fund` will fund the RETIRED pool, unrecoverably

`frontend/scripts/bayla-lighthouse-ceremony.mjs:486` takes `--pool` verbatim and
validates only that it is non-empty. A mistyped or stale address sends tokens to
a vault nobody stakes against. Same class on the EVM side:
`contracts/script/FundLighthouseStaking.s.sol:34` accepts any POOL, with twelve
indistinguishable live pools and no rescue function on either contract.

**FIX** — pin the live destination in code and refuse anything else without an
explicit override; add `require(pool.code.length > 0)` and a chain gate to the
EVM funding script.

**STATUS 2026-09-05 — the funding half is CLOSED, the shipping half is now GUARDED.**

- Funding: `FundLighthouseStaking.s.sol` gained `assertFundableBuild()` (PR #393),
  called from `run()` before anything else, and it refuses a pre-fix ladder outright
  (`"POOL: PRE-FIX ladder build (no MIN_STAKE) - refusing to fund, redeploy first"`).
  It discriminates on `totalBoosted()`, not `MIN_STAKE()`, because a PRE-FIX ladder and
  a legitimately floorless PLAIN pool both revert `MIN_STAKE()`.
- Shipping: funding was blocked, but nothing stopped us SHIPPING A UI pointing users at
  the six pre-fix pools — a forgotten registry repoint after a redeploy fails silently.
  `npm run verify-ladders` (`scripts/verify-ladder-builds.mjs`) now reads the shipped
  registry (`frontend/src/lib/bungalows.ts`) and asks the chain about every
  `poolKind: 'ladder'` entry. Exit 1 unless all of them run the audited fixed build.
  An unreadable pool FAILS — an RPC outage must never certify a vulnerable registry.

**Measured 2026-09-05:** all six still `6098` bytes, `MIN_STAKE()` reverting, and all six
still `totalSupply/rewardRate/periodFinish == 0`. The redeploy is therefore still a
REPLACEMENT, not a migration — that window closes the moment anyone stakes.

Order of operations for the redeploy:
1. `DeployLighthouseLadder` (L-INV-11/12 stop a pre-fix build going out)
2. repoint `frontend/src/lib/bungalows.ts` + `addresses.json` to the new addresses
3. `npm run verify-ladders` — must exit 0 before the frontend ships
4. stake an honest position, THEN `FundLighthouseStaking` (an empty pool hands its
   first period to whoever watches the mempool; `MIN_STAKE` cannot fix that)

## C5 — CRITICAL: every Streamflow program shares one non-multisig upgrade key

All five programs the BAYLA rail depends on are BPF-upgradeable under a single
plain keypair. The rail is described in docs and UI as "audited, non-custodial",
which omits the largest risk on it.

**FIX** — not ours to fix, so disclose it: `docs/BAYLA_BUNGALOW.md` §5b and the
UI risk copy.

---

## HIGH — the rest, grouped

**Contract.** `emergencyWithdraw` (`:292`) omits `updateReward`, destroying the
caller's accrual and leaving part of the emission permanently unassignable, and
it shrinks `rewardPerToken()`'s divisor without checkpointing. Exits are
all-or-nothing (`:266`, `:299`), so a **0.08% shortfall costs the last staker
100%** of their position, and `emergencyWithdraw` reverts when short instead of
clamping. Max boost is purchasable: `boostFor` prices the *requested* duration,
the weight is never re-rated, and abandoning costs a flat 25% (`:279`). Boost
weight never decays (`:254`). `stake()` credits the pool's balance delta as
caller principal (`:238`) — a rebasing or reflection token lets a 1-wei staker
mint the pool's gains as withdrawable principal. The immutable
`rewardsDistribution` on five Base ladders points at a Safe the repo records as
never having executed a transaction (`:155`), with no rotation path.

**Solana rail.** The only exit wired is `unstakeAndClaim`
(`bungalowStaking.ts:639`), so a short reward vault **holds matured principal
hostage** — the SDK's `unstakeAndClose` escape hatch is never exposed. Emissions
scale with uncapped TVL against a fixed vault, and the only on-chain throttle is
refused for 365 days at a time. `nextVacantNonce` (`:522`) treats a CLOSED entry
as freeing its nonce — it does not, so a returning staker's second stake reverts
forever. **1 BAYLA of permissionless funding flips the honest "staking paused,
paying 0%" state into a green live APR** at zero TVL (`:730`).

**UI.** The MAX button round-trips a locale-formatted balance back through the
raw parser (`LighthousePoolLive.tsx:362`) — in de-DE / pt-BR / it-IT / nl-NL it
silently stakes **1/1000th** of the balance. The EVM ladder renders a failed
positions read as "you have no positions" (`EvmLadderPoolLive.tsx:115`) — the
exact outage-as-zero the Solana card was built to avoid — and offers
`emergencyWithdraw` as "Principal only" while the contract charges the same 25%
(`:321`).

**Docs.** `TODO_OPERATOR.md:76/80` still prints a deploy command for the
superseded, principal-unsafe contract on top of a live pool, and its funding
runbook resolves EVM addresses through `lighthouse-*` ids that are all retired.

## WHAT HELD UP

100 findings were refuted. The honesty architecture on the Solana card
(labelled real zero vs outage, "paying now" vs "configured", no synthesized
APR), the Token-2022 detection, the receipt-ATA pre-creation, the `unlisted`
route gating and the `solrpc` origin allowlist all survived attack.
`nonReentrant` coverage is correct everywhere except `notifyRewardAmount`.

## ACTION ORDER

1. **C1 + C2** in source, together — C2 is C1's precondition. Keep the PoC as a
   permanent regression test.
2. **C3** — rotate the key, move the folder, kill the scheduled task.
3. Redeploy the six ladders and repin the registry. Do not accept a deposit
   before this.
4. **C4** — pin funding destinations in both scripts.
5. Wire `unstakeAndClose`; fix `nextVacantNonce`; fix the MAX locale bug.
6. **C5** and the docs corrections — disclosure, not code.
