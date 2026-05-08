# Agent 18 — GaugeController.sol Commit-Reveal Voting Audit

**Target**: `contracts/src/GaugeController.sol` (1054 lines)
**Lens**: H-2 commit-reveal voting protocol correctness
**Date**: 2026-05-07

---

## Summary

Reviewed all commit-reveal lenses (commit hash construction, salt usage, replay
protection, window timing, snapshot timing, multi-NFT rotation, DoS surface,
cancellation race, gauge replay across epochs, and grindable salt scenarios).

The implementation is unusually well-hardened — most of the obvious lenses are
already explicitly addressed (and labelled by prior audit notes: AUDIT
R014-HIGH, R014-MEDIUM, AUDIT C2, DEEP-GOV-07, NEW-I2). I found **3 LOW /
INFO-grade observations** that do not materially affect protocol security but
may produce bad UX in narrow edge conditions; and **1 INFO** that is purely a
robustness suggestion. All H/M-tier exploit attempts I tried already fail
because of an existing guard.

---

## Pre-existing guards verified

For traceability, the following commit-reveal lenses were checked and confirmed
already-mitigated:

| Lens | Mitigated by |
|------|--------------|
| Commit hash collision / weak hashing | `keccak256(abi.encode(...))` with full-word ABI encoding of all components (line 446-448) |
| Hash binds voter address | Yes — `voter` is the 3rd encoded field (line 447) |
| Hash binds tokenId | Yes — line 447 |
| Hash binds gauges + weights | Yes — line 447 |
| Hash binds salt | Yes — line 447 |
| Hash binds epoch | Yes — line 447 (NEW-I2 fix) |
| Hash binds chainid | Yes — `block.chainid` (NEW-I2 fix) |
| Hash binds contract | Yes — `address(this)` (NEW-I2 fix) |
| Cross-epoch replay | Closed via epoch in hash + `commitmentOf[tokenId][epoch]` slot scoped to epoch |
| Reveal-by-stranger / commit theft | `committerOf[tokenId][epoch] != msg.sender → NotCommitter` (line 595) |
| Re-commit during commit phase | `commitmentOf[tokenId][epoch] != bytes32(0) → AlreadyCommitted` (line 469); per-user `userActiveCommit` (line 481) |
| Reveal in commit phase | `block.timestamp + REVEAL_GRACE < revealOpens → RevealWindowNotOpen` (line 589) |
| Commit in reveal phase | `block.timestamp + REVEAL_GRACE >= revealOpens → CommitWindowClosed` (line 467) |
| Multi-NFT commit rotation | `userActiveCommit` per-user guard (line 481) plus `cancelCommit` window blocked one full REVEAL_GRACE before reveals can be admitted (line 522) |
| Snapshot timing for vote-power | Pinned to `epochStartTime(epoch) - 1` at BOTH commit-time pre-check (line 485) AND reveal-time application (lines 624-626). `min(historical, current)` clamp neutralises divest-then-vote (line 358, 631). |
| Reveal-then-unstake | The `min(historical, current)` clamp at REVEAL TIME means a voter who unstakes between epoch-start snapshot and reveal has their reveal power crushed to current power (which is now lower or zero). This is the DEEP-GOV-01 fix (line 631). |
| ZeroCommitment | Explicit revert (line 458) |
| ZeroVotingPower | Explicit revert at reveal (line 632) |
| ZeroWeight | Explicit revert (line 638) |
| Per-user one-vote per epoch | `hasUserVotedInEpoch` (line 605) |
| Cancellation see-and-cancel race | `block.timestamp + 2 * REVEAL_GRACE >= revealOpens` (line 522) — closes cancellation one full REVEAL_GRACE BEFORE the earliest reveal admission. R016 M-1 fix. |

The hash construction is identical in shape to `VoteIncentives.computeCommitment`, and binds (chainid, contract, voter, tokenId, gauges, weights, salt, epoch). I could not construct a collision or a stranger-reveal scenario.

---

## Findings

### F-18-1 — INFO: Trailing-grace look-back relies on commit being EMPTY in the new epoch (DoS via dust commit)

**Severity**: INFO (UX edge, not exploitable for fund loss)
**Location**: `revealVote()`, lines 557-580
**Scope**: trailing 5-minute REVEAL_GRACE window after epoch boundary

#### Description

`revealVote()` includes a defensive look-back to handle reveals that arrive
slightly after the epoch boundary (DEEP-GOV-07 fix). The condition for treating
the call as a reveal of the **previous** epoch is:

```solidity
if (commitmentNow == bytes32(0) && commitmentPrev != bytes32(0)
    && block.timestamp <= graceBoundary) {
    epoch = prev;
}
```

It requires `commitmentNow == bytes32(0)`. If a malicious actor (or an
overzealous voter) submits a fresh commit for the user's tokenId in the **new**
epoch BEFORE the user can reveal their previous-epoch commit during the
trailing-grace zone, the look-back is skipped — the reveal targets `nowEpoch`
instead, and lookups fail with `CommitmentMismatch` (the salt/gauges hash
against `epoch=nowEpoch`, but the committed hash was against `epoch=prev`).

In practice this is exploitable only by:
1. An NFT owner committing twice (legitimate use — they already locked
   themselves into the new commit anyway, which is fine).
2. The OWNER themselves, who is the only party allowed to commit with their
   tokenId — and they can simply call with `epoch = prev` would not help
   because the function does not accept an epoch parameter.

But the NotTokenOwner check (line 459) means strangers cannot grief this. The
only griefer is the owner themselves, and they have no incentive to do so.

#### Risk

**Not exploitable** — the only party who could clobber is the owner of the
NFT. The look-back is a UX nicety, not a security guarantee. If a user
forgets to reveal until the trailing-grace window AND they manage to also
commit for the new epoch in that same 5-minute window, they lose their
previous reveal.

The new-epoch commit window opens at `nowEpochStart` (the user is still in
the trailing-grace zone for `prev` and simultaneously in the head-of-epoch
commit zone for `nowEpoch`). So a careless user transaction sequence
(reveal-prev, commit-now) could fail the reveal if the commit lands first.

#### Recommendation

Consider taking an explicit `targetEpoch` parameter to disambiguate, or revert
with a clearer error than `CommitmentMismatch` when the look-back was disabled
purely because a new-epoch commit happened to be present. Optional polish.

---

### F-18-2 — LOW: `lastVotedEpoch` is metadata-only but still updated by every successful (re)vote — no-op for reveal flow

**Severity**: INFO (already documented in code as metadata-only)
**Location**: lines 386, 652
**Scope**: read-only side-channel

`lastVotedEpoch[tokenId] = epoch` is written on every vote and reveal. The
codebase already documents this as metadata-only ("reads 0 for never voted
AND for voted in epoch 0 — do NOT use as a guard", line 136). Verified that
no other contract uses `lastVotedEpoch` as a guard; it's purely an event-side
mirror. Acknowledged in code, no fix needed.

---

### F-18-3 — INFO: Salt grindability — not exploitable in this construction

**Severity**: INFO (no finding — verifying lens)
**Location**: `computeCommitment` (line 446-448)

The salt is a user-supplied `bytes32`. Because the hash includes (voter,
tokenId, gauges, weights, epoch, chainid, address(this)), grinding the salt
gives an attacker no leverage over:

- Vote outcome (gauges+weights are fixed in the hash)
- Front-running (the committer is bound to msg.sender)
- Predicting other users' commitments (they bind to their own voter address,
  tokenId, salt — all unknown to attacker)

The only way salt-grinding could matter is if the salt itself were used
elsewhere as randomness (e.g., a tie-break PRNG). It is not. Salt is purely
a hiding nonce. Confirmed safe.

---

### F-18-4 — LOW: Mass-commit DoS surface bounded by per-NFT and per-user guards

**Severity**: INFO (bounded by existing guards)

Commit-reveal protocols often have a DoS surface where griefers can submit
many trash commits to inflate downstream iteration. In this contract:

- Reveal phase processing is **pull-based** — each user reveals their own
  vote. There is no single function that loops over all commits.
- Per-NFT, per-epoch limit is 1 commit (`commitmentOf[tokenId][epoch]`).
- Per-user, per-epoch limit is 1 active commit (`userActiveCommit`).
- Each commit costs a real ERC-721 ownership check + storage writes.

A griefer with 1000 NFTs (impossible — TegridyStaking has its own per-EOA
single-NFT guard for EOAs; for contracts they'd need to deploy 1000 wrapper
contracts and pay the gas) could only commit 1000 trash commits, none of
which trigger any iteration in any other reachable function. No DoS surface.

---

### F-18-5 — INFO: `computeCommitment` is `view`, not `pure` — minor gas waste for off-chain callers

**Severity**: INFO (gas)
**Location**: line 433

`computeCommitment` reads `block.chainid` and `address(this)` so cannot be
`pure` (chainid would mark it view). The function is correct as is. Off-chain
callers can compute it client-side via `ethers.utils.solidityKeccak256` to
save the RPC round-trip. Not a finding.

---

### F-18-6 — INFO: Epoch-boundary same-block stake correctly excluded (BATCH-H M21 fix)

**Severity**: INFO (verifying lens — fix is in place)
**Location**: lines 351-356, 624-629

The reveal-time and commit-time historical lookup uses
`epochStartTime(epoch) - 1`, so an attacker who stakes at `epochStartTime(epoch)`
in the same block as their commit/reveal does NOT have that stake counted
toward voting power. The `min(historical, current)` clamp also crushes the
attack from the other direction. Both paths verified hardened.

---

## Dead-end attempts (not findings, recorded for completeness)

1. **Commit-then-divest**: Attacker commits with full power, divests, then
   reveals. **Closed by**: `min(historical, current)` clamp at reveal time
   (line 631) — divested current power crushes the historical snapshot.

2. **Reveal someone else's commit with a guessed salt**: If salt is 32 bytes
   of entropy, pre-image attack is 2^256 work. **Closed by**: `committerOf`
   check (line 595) makes salt-guessing pointless even if entropy were
   somehow weak — only the committer can reveal.

3. **Replay last epoch's commit hash**: Hash binds `epoch`. **Closed by**:
   line 447.

4. **Cross-chain replay (forks, deterministic deploys)**: Hash binds chainid
   and contract address. **Closed by**: NEW-I2 fix.

5. **Same-tokenId double-commit by multiple owners (NFT transfer mid-commit)**:
   committerOf is locked at commit-time. New owner can't reveal because
   committerOf would still point at old owner. New owner ALSO can't
   commit because `commitmentOf[tokenId][epoch] != bytes32(0)`. Vote is
   permanently abandoned that epoch — but no fund loss, only forfeiture. The
   per-user `userActiveCommit` slot for old owner is also locked, so old
   owner can't commit with another NFT either. This is a deliberate UX
   trade-off, not a bug. (Cancel is also blocked once reveal window opens,
   but old owner would still be able to cancel during the commit phase.)

6. **Boundary-block stake**: `epochStartTime(epoch) - 1` lookup blocks this.

7. **Very-late commit forces user to reveal in 0 seconds**: Last possible
   commit moment is `revealOpens - REVEAL_GRACE - 1`. After that, commits
   revert with `CommitWindowClosed`. So a user who commits 1 second before
   the latest acceptable commit moment still has at LEAST `REVEAL_GRACE`
   plus the entire 24h reveal window to reveal. No "0-second reveal"
   trap.

8. **Race: commit + cancel in same block to avoid `userActiveCommit` slot
   ever blocking**: Cancel still requires `block.timestamp + 2 * REVEAL_GRACE
   < revealOpens` (line 522), so this ONLY works during the early commit
   phase. During that window, cancel is intended to work — re-committing
   with a different NFT/weights is the documented use case. Not an attack.

9. **Reveal during the 5-minute grace window with zero commit**: Caller must
   present a commit hash that matches the stored `commitmentOf[tokenId][epoch]`.
   `bytes32(0)` reverts NoCommitment. Safe.

10. **Snapshot manipulation via flash-stake at exactly `epochStartTime(epoch)`
    block**: The `epochStartTime(epoch) - 1` historical lookup excludes the
    epoch-start block from the upperLookup result. Combined with the
    `min(historical, current)` clamp, this neutralizes flash-stake-vote-unstake
    at both boundaries.

---

## Final assessment

**No new H/M findings.** The commit-reveal voting implementation is
defensively coded with explicit fixes for every standard commit-reveal
attack. The only observations are UX edges (F-18-1) and INFO-grade items
that match prior audit fixes already in place.

**Risk score**: NONE NEW — pre-existing guards cover all standard lenses.
**Confidence**: HIGH — read every line of the commit-reveal flow and the
VotePowerOracle library, traced each potential exploit path, all blocked.
