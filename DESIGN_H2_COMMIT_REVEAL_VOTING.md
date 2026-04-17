# H-2 — Commit-Reveal Voting Design Spike

**Status:** design proposal, not implementation
**Scope:** VoteIncentives.vote + GaugeController.vote
**Finding:** parallel-reviewer HIGH (paired with Spartan TF-13 context)
**Author:** Claude Opus 4.6 — Apr 17, 2026

---

## 1. Problem statement

Both vote paths currently follow a **see-everything-then-vote** pattern:

### VoteIncentives.vote (contracts/src/VoteIncentives.sol:254)
- Voter calls `vote(epoch, pair, power)` anywhere from epoch snapshot to `snapshot + VOTE_DEADLINE` (7 days).
- Between those two timestamps, `depositBribe(...)` is permissionless and public. Every bribe landing on a pair is an emitted `BribeDeposited` event, visible to every watcher.
- A voter — especially a large one — can wait until hour 167 of the 168h window, read the on-chain bribe ledger, and allocate 100% of their power to the single pair with the highest bribe-per-vote ratio.
- This is **rational** under the current rules but it destroys the intended incentive design: bribes are supposed to steer gauge weight *before* voters know exactly how much is there, not after.

### GaugeController.vote (contracts/src/GaugeController.sol)
- Batch 8 moved voting power to the epoch-start snapshot (`votingPowerAtTimestamp(user, epochStartTime(currentEpoch))`). That closed the **stake-vote-exit** arbitrage.
- The **see-bribes-then-vote** arbitrage remains: a voter still watches VoteIncentives' bribe flow and allocates GaugeController votes to match. Both systems are coupled.

### Side-effect the fix also has to preserve
- 7-day voting window exists for UX reasons (users don't check the app every day).
- Unvoted bribes fall into the `BRIBE_RESCUE_DELAY` (30d) queue. Commit-reveal must not break that queue or worsen the unvoted-orphan problem (Spartan TF-13).

---

## 2. Threat model

| Actor | Capability | Attack |
|---|---|---|
| Whale voter | Large staking position | Sees all bribes accumulate for 7 days, votes 100% to highest-$/vote pair at hour 167. |
| Bribery protocol (e.g. Paladin/Hidden Hand-style) | Offers off-chain incentives to voters | Already rational; commit-reveal doesn't eliminate bribery but makes it harder to optimally place last-second. |
| Coordinated pool | Multiple stakers coordinate off-chain | Same as whale but distributed; same fix applies. |
| Sybil / small holder | Can't move the needle | Not the target of the fix. |

**Out of scope:** off-chain collusion, vote-buying through side channels. Commit-reveal only addresses on-chain visibility.

---

## 3. Design proposal — two-phase commit-reveal

### 3.1 Phases per epoch

```
Epoch N timeline (7-day epoch, proposed split 4d commit + 3d reveal):

  advanceEpoch()                       commitDeadline                 revealDeadline
        │                                    │                               │
        ├───────── 4 days ──────────────────►├──────── 3 days ──────────────►│
        │           COMMIT WINDOW            │        REVEAL WINDOW          │
        │                                    │                               │
  bribes also land in           commits locked;       voters reveal with
  Epoch N+1's pre-snapshot      no new votes;         (pair, power, salt)
  bucket (current)              bribes still can      per the commit hash
                                land (see §3.5)
```

### 3.2 Commit

Voter computes off-chain:
```
commitHash = keccak256(abi.encode(msg.sender, epoch, pair, power, salt))
```
and calls:
```solidity
function commitVote(uint256 epoch, bytes32 commitHash) external whenNotPaused;
```

- Rejects if epoch is past `commitDeadline`.
- Stores `voterCommit[msg.sender][epoch] = commitHash`.
- One commit per (voter, epoch). Re-committing during the window overwrites (choice).
- Emits `VoteCommitted(user, epoch, commitHash)`.

No bribe information is revealed by the commit — voters haven't yet disclosed which pair they'll back.

### 3.3 Reveal

After `commitDeadline`:
```solidity
function revealVote(
    uint256 epoch,
    address pair,
    uint256 power,
    bytes32 salt
) external whenNotPaused;
```

- Rejects before `commitDeadline` or after `revealDeadline`.
- Recomputes `keccak256(abi.encode(msg.sender, epoch, pair, power, salt))` and checks against `voterCommit[msg.sender][epoch]`.
- If match: applies the vote (same accounting as current `vote`: `gaugeVotes`, `totalGaugeVotes`, `userTotalVotes` updated; `userPower` snapshot at `epochs[epoch].timestamp`).
- Emits `VoteRevealed(user, epoch, pair, power)`.
- One reveal per commit. After reveal, commit is cleared.

### 3.4 Unrevealed commits

The hardest design question. Three defensible policies:

| Policy | Description | Trade-off |
|---|---|---|
| **A. Forfeit** | Unrevealed commits don't count toward any pair. Voter loses the vote but nothing else. | Simple. Punishes legitimate "meant to reveal but forgot" voters. Creates a **dead-vote sybil DoS** — an attacker commits junk to reduce the legitimate vote pool's relative weight on popular pairs. |
| **B. Default allocation** | Unrevealed commits fall into a system-chosen pair (e.g. a "no preference" sink or pro-rata to existing votes). | No dead votes. But attackers can still commit junk to game the sink. |
| **C. Commit-bond** | Committing requires a small TOWELI bond refunded on reveal; forfeited bond goes to treasury if commit is never revealed. | Costs the attacker to grief. Slight UX friction. Bond size must be tuned — too high = disincentivises normal voters, too low = griefing still cheap. |

**Recommendation: C (commit-bond)**, bond size ~10 TOWELI (~= $0.40 at current price), scaled to `MIN_STAKE` ratio. This preserves voter discipline without materially burdening good-faith users. Unbonded Option A is simpler but the dead-vote DoS is exactly the kind of novel attack this design is supposed to prevent.

### 3.5 Bribe deposits during commit/reveal

**Keep bribe deposits permissionless throughout both windows.** That's the only way to preserve the current briber UX (bribe anytime before reveal-deadline). The privacy property comes from voters not being able to see the *full* bribe picture until AFTER their commit lands — but bribes can keep accruing right up to reveal deadline.

An alternative is to cut off bribe deposits at `commitDeadline` so voters know the exact bribe set when they reveal. This makes the brrribery protocol's lifecycle cleaner but is hostile to briber UX. Recommendation: keep deposits open; document that late-deposited bribes compete for already-committed vote allocations.

### 3.6 Storage additions

```solidity
// VoteIncentives.sol (new state, packed)
struct CommitInfo {
    bytes32 commitHash;    // 32 bytes
    uint96  bond;          // 12 bytes — TOWELI bond for commit
    bool    revealed;      // 1 byte
}                          // total 45 bytes (two slots)

mapping(address => mapping(uint256 => CommitInfo)) public voterCommits;
uint256 public commitRatio = 4000; // BPS of VOTE_DEADLINE, 40% = 4 days out of 7
uint256 public commitBond = 10 ether; // TOWELI — governance-tunable
IERC20 public toweli; // bond token

// Derived getters
function commitDeadline(uint256 epoch) public view returns (uint256) {
    return epochs[epoch].timestamp + (VOTE_DEADLINE * commitRatio) / 10000;
}
function revealDeadline(uint256 epoch) public view returns (uint256) {
    return epochs[epoch].timestamp + VOTE_DEADLINE;
}
```

### 3.7 Migration path

Options:

- **Clean swap:** new epochs after a governance proposal use commit-reveal; legacy `vote()` is deleted. Clean but breaks anyone who depends on the old signature (gauge-voting indexers, frontend). Acceptable because the VI surface is 100% this protocol's.
- **Versioned flag per epoch:** `epochs[epoch].usesCommitReveal = true|false`, set at `advanceEpoch`. Old `vote()` path kept for back-compat on legacy epochs. Slightly more code, smooth rollout.

**Recommendation: versioned flag.** Ship commit-reveal for new epochs only; legacy `vote()` becomes a revert-with-DeprecatedPath error after a 30-day grace window.

### 3.8 Frontend implications

- Voter UX now has two clicks separated by up to 4 days. UI must: (a) generate and store the salt locally (ideally to localStorage keyed by epoch + account + pair + power so refresh doesn't lose it); (b) remind the user to reveal before deadline; (c) fall back to "you forgot to reveal — bond forfeited" copy if they miss.
- Gauge emission indexers need to read both `VoteCommitted` and `VoteRevealed` events.
- The existing `voteFor` / `splitVote` patterns (if any UX helpers exist) need to re-route through `commitVote`.

### 3.9 Gas / storage cost

- Commit: 1 SSTORE (new) + 1 SSTORE (bond transfer) ≈ 42k gas.
- Reveal: 1 SLOAD + 1 keccak + vote-application writes (same as current vote) ≈ 90-120k gas depending on gauge count.
- Total = ~130-160k for a vote round-trip, up from ~80k for plain `vote`. Acceptable.

---

## 4. What this does NOT fix

- **Off-chain collusion.** Two voters can still agree off-chain to both commit identical payloads — the privacy is only against public on-chain inspection.
- **Reveal-order games.** If voter A reveals first and voter B sees A's allocation, B can tune their own reveal to their advantage. Mitigation: reveals are irrevocable and bound to the pre-committed hash, so B can't actually re-target — at worst B can decide whether to reveal or forfeit their bond. This is already the minimum viable property.
- **Spartan TF-13 orphaned bribes.** Unvoted bribes still fall into the 30-day `BRIBE_RESCUE_DELAY`. Commit-reveal doesn't help or hurt.
- **GaugeController-side voting.** This design is scoped to `VoteIncentives.vote`. A matching commit-reveal can be applied to `GaugeController.vote` using the same framework, but it's a separate deploy.

---

## 5. Open questions for governance

1. **Commit ratio:** 40% of VOTE_DEADLINE (4d commit / 3d reveal) is a starting point. Longer commit window = more bribes unseen at vote-decision time. Shorter = easier UX. Needs governance sign-off.
2. **Bond size:** 10 TOWELI is a guess; tune so committed-and-not-revealed rate stays below ~5% of commits in normal operation.
3. **Bond destination:** unrevealed bond forfeits to treasury, or burn, or rolls forward to reward revealed voters pro-rata? Recommend treasury for simplicity.
4. **Commit hash domain:** does it include `block.chainid` to prevent cross-chain replay if the contract gets redeployed? (Yes — add it.)
5. **One commit per epoch vs split commit:** current design allows one commit per (voter, epoch) covering a single pair. If voters want to split power across pairs, they need multiple commits. Either allow arrays in `commitVote(epoch, bytes32[] hashes)` or keep single-pair-per-epoch as a simplifier.

---

## 6. Recommended implementation order if approved

1. Spec a test harness that verifies the invariants:
   - reveal without matching commit reverts
   - reveal with wrong salt reverts
   - re-commit during window overwrites
   - late reveal reverts
   - forfeit bond goes to treasury on missed reveal
   - vote accounting after reveal matches current `vote()` output for equivalent inputs
2. Add storage + commit/reveal functions behind a `usesCommitReveal` epoch flag (§3.7).
3. Wire the bond — needs TOWELI address on VoteIncentives, OZ SafeERC20.
4. Add an epoch-sweeper that collects forfeited bonds at `revealDeadline + grace` (1 day).
5. Ship migration governance proposal that flips `usesCommitReveal` on for future epochs and sunsets the old `vote()` path after 30 days.
6. Frontend: localStorage salt store, reveal reminder UI, dashboard for in-flight commits.

Out of scope for this doc: implementation itself. Sign-off on ratios / bond / migration strategy first.

---

## 7. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Shorten `VOTE_DEADLINE` to 24h (from 7d) | Only partial mitigation (whale sees 24h of bribes, still beats small voters). Hurts UX massively. |
| Block bribe deposits for the last 48h of the window | Makes the brrribery contract's life hard. Hostile to the bribery protocol's usability. Doesn't prevent off-chain coordination on the already-seen bribes. |
| Require voters to stake longer than the epoch | Doesn't help with the "see-then-vote" privacy issue; only with the separate stake-vote-exit issue (which GaugeController TF-04 already addressed via epoch-start snapshot). |
| Private voting with ZK proofs | Large engineering investment; ecosystem not there yet on the RPC layer. Defer to a future major release. |

---

*End of design spike. Sign-off required on commit-ratio, bond size, and migration strategy before implementation.*
