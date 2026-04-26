# Agent 042 — Signature / EIP-712 / Replay Surface

**Mode:** AUDIT-ONLY. No code changes. Date: 2026-04-25.

## Scope

Hunted across `contracts/src/**.sol` for:
`ecrecover`, `EIP712`, `_hashTypedDataV4`, `permit`, `_PERMIT_TYPEHASH`,
`DOMAIN_SEPARATOR`, plus broader signature/nonce/commit-reveal patterns.

## Surface inventory (per contract)

| Contract | Pattern | Verdict |
|---|---|---|
| `Toweli.sol` | OZ `ERC20Permit` (EIP-2612) | OK — inherits OZ EIP712, chainid+addr-bound, per-owner nonce, deadline check, ECDSA s-malleability handled by OZ ECDSA.recover |
| `TegridyPair.sol` | None — `permit` mentioned only in AUDIT NOTE #65 saying it is **not implemented** | OK — LP tokens have no permit |
| `GaugeController.sol` | Commit-reveal voting (no signatures) | OK — `computeCommitment` binds `(block.chainid, address(this), voter, tokenId, gauges, weights, salt, epoch)` |
| `VoteIncentives.sol` | Commit-reveal voting + 10 TOWELI bond | OK — `computeCommitHash` binds `(block.chainid, address(this), user, epoch, pair, power, salt)` |
| `TegridyDropV2.sol` | Merkle allowlist (double-hashed leaf) | OK — leaf binds `(address(this), msg.sender)`; no signatures |
| `MemeBountyBoard.sol` | None | n/a |
| `CommunityGrants.sol` | None | n/a |
| `PremiumAccess.sol` | None | n/a |
| `TegridyNFTLending.sol` | None — bids are direct on-chain offers, no signed off-chain orders | n/a |
| `TegridyNFTPoolFactory.sol` | "nonce" appears only in CREATE2 commentary | n/a |
| All other src files | none | n/a |

## Key findings (no exploitable replay vectors discovered)

### Audit checks performed

1. **Missing chainid in DOMAIN_SEPARATOR / L2-fork replay** — N/A: only Toweli uses
   EIP-712 and inherits OZ EIP712 which caches DOMAIN_SEPARATOR but re-derives
   when `block.chainid != _cachedChainId` (lib path:
   `contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol`
   lines 83-91). Fork-safe.

2. **Missing nonces** — Toweli `_useNonce(owner)` per OZ `Nonces`. Both
   commit-reveal contracts use one-shot commits cleared on reveal
   (`commitmentOf` deleted, `c.revealed = true`).

3. **Nonce that doesn't increment per call** — N/A. OZ implementation increments
   correctly; commit-reveals are single-use.

4. **ECDSA s-value malleability** — only Toweli's permit path; OZ ECDSA library
   enforces `s <= secp256k1n/2` and rejects `v != 27|28`. Battle-tested.

5. **`ecrecover` zero-return unhandled** — no raw `ecrecover` calls anywhere in
   `contracts/src` (verified with `\\becrecover\\s*\\(` grep — zero hits).

6. **Multi-contract domain reuse** — Toweli is the only EIP-712 verifier; both
   commit-reveal hashes include `address(this)`, so a commit hash for
   `GaugeController` cannot be replayed against `VoteIncentives` and vice versa.

7. **Deadline absent / far-future** — Toweli enforces `block.timestamp > deadline`
   revert via OZ `ERC2612ExpiredSignature`. Commit-reveal windows are bounded
   by `commitDeadline` / `revealDeadline` and `REVEAL_WINDOW = 24h`.

8. **Off-chain authority key** — **NONE EXIST.** No backend signer, no relayer,
   no `trustedForwarder`, no `EIP1271` `isValidSignature`. All authority is
   on-chain `onlyOwner` (multisig) + timelock. Strong design choice — entire
   signed-authority class of bugs is absent.

9. **Signed-amount vs used-different-param** — In VoteIncentives `revealVote`
   the `power` and `pair` from calldata are hashed and matched to the stored
   commit (line 1093). In GaugeController same pattern (line 352). No silent
   parameter substitution possible.

### Notes / mild observations

- **OBSERVATION 1 (INFO):** `GaugeController.commitVote` does NOT set
  `hasVotedInEpoch[tokenId][epoch]`; only `revealVote` does. That means a user
  can `commitVote(tokenId)` then call legacy `vote(tokenId)` in the same epoch.
  The commit becomes orphaned (cannot be revealed because `hasVotedInEpoch` is
  now true and `revealVote` line 346 reverts). Not a replay or theft; only
  user self-bricking. Could be tightened by setting the flag at commit time and
  releasing it on reveal-rollback, but current behavior is benign and follows
  the file's design intent (legacy + commit-reveal can co-exist by tokenId
  uniqueness).

- **OBSERVATION 2 (INFO):** `VoteIncentives.commitVote` allows multiple commits
  per (user, epoch) (`voterCommits[user][epoch]` is an array). Each carries its
  own `commitHash` and bond. The cap enforcement in `revealVote`
  (`userTotalVotes[msg.sender][epoch] + power <= userPower`) prevents
  voting-power amplification. Bonds for unrevealed commits are sweepable to
  treasury after `revealDeadline`. Sweep vs. refund mutual exclusion is
  enforced by `c.bond = 0` write before transfer (CEI) and a
  `BondAlreadyClaimed` revert. No double-pay.

- **OBSERVATION 3 (INFO):** `TegridyDropV2` Merkle leaf is double-hashed per OZ
  recommendation, defeating second-preimage attacks against the tree.
  Off-chain tree builder must apply the same shape — code comment line 286
  documents this.

- **OBSERVATION 4 (INFO):** `Toweli` is deployed at the canonical CREATE2
  vanity address. ERC20Permit `name()` is `"Toweli"` and EIP712 version is the
  default `"1"`. No re-deploy hazard; the cached DOMAIN_SEPARATOR is bound to
  Mainnet chainid + Toweli address.

## Exploit risk score: 0 / 10

There is no credible signature-replay or off-chain-authority attack surface in
this codebase. The design pointedly avoids signed-message authorization in
favor of on-chain commits/timelocks.

## Files touched

None. Audit-only.
