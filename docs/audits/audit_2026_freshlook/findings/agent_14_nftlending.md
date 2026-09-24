# Agent 14 — TegridyNFTLending fresh-look exploit hunt

**Scope:** `contracts/src/TegridyNFTLending.sol` (1285 lines), peripheral: `lib/SafeERC721Call.sol`, `lib/SequencerCheck.sol`, `lib/WETHFallbackLib.sol`, `base/TimelockAdmin.sol`. Also reviewed `TegridyNFTPool.sol` / `TegridyNFTPoolFactory.sol` for cross-contract NFT semantics.

**Method:** Read-only inspection across the 20+ NFT-specific exploit lenses listed in the task brief, plus boundary/CEI/reentrancy/pause/sequencer permutations. No tests run.

**Verdict:** No high-severity contract bug found. The contract is heavily hardened with extensive prior-audit fixes. Findings below are structural / operational / informational.

---

## Findings

### F-14-1 (LOW / OPERATIONAL) — `setSequencerFeed` is a one-shot with no deployment-time enforcement on L2 deploys

**Path:** `contracts/src/TegridyNFTLending.sol:354-396`

The constructor hard-codes `sequencerFeed = address(0)`. The post-deploy setter is one-shot:
```
if (sequencerFeed != address(0)) revert SequencerFeedAlreadySet();
```
On an L2 deploy (Arbitrum / Optimism / Base), if the operator forgets to call `setSequencerFeed`, every `checkSequencerUp` and `getSequencerOutageBuffer` no-ops. The L2 sequencer protections that the rest of the audit history added (DEEP-LD-M10, DEEP-LIB-H3, DEEP-LD2-H1, BATCH-L3 M4) are ALL bypassed. There is no on-chain way to detect this misconfiguration after the fact, and no way to fix it: one-shot means a misconfigured deploy must be re-deployed.

**Suggested mitigation:** make `setSequencerFeed` mandatory at deploy time (constructor parameter on L2 deploy script) or add a `bool sequencerInitialized` separate from the address so a 0x0 address cannot pass undetected. Alternative: have `setSequencerFeed` accept `address(0)` exactly once to mark "mainnet, no feed" so the absence of a call is no longer ambiguous.

**Severity:** Low (operational, recoverable by re-deploy). Documented design.

---

### F-14-2 (INFORMATIONAL) — `proposeWhitelistCollection` accepts a `supportsInterface(0x80ac58cd)` revert as a pass

**Path:** `contracts/src/TegridyNFTLending.sol:1029-1033`

```
try IERC165(_collection).supportsInterface(0x80ac58cd) returns (bool ok) {
    require(ok, "NOT_ERC721");
} catch {
    // Pre-ERC165 ERC721 — allow but operator should know.
}
```

A contract that REVERTS on `supportsInterface` slips past the gate (the comment acknowledges this for legacy collections like CryptoPunks v1). A malicious contract can implement just enough of `transferFrom` and `ownerOf` to satisfy `acceptOffer`'s post-condition (`ownerOf == address(this)`) at escrow time, then mutate behavior post-loan. This collapses to the standard "compromised-collection" risk class — already mitigated by:
- 24h timelock on whitelist add
- `_safeOutboundTransfer` post-condition check on outbound transfers (LD-NEW-H2)
- `stuckCollateralRecipient` recovery mapping
- `CollateralRedirected` forensic event

But the lender remains exposed to a post-listing rug for the duration of any active loan against the rugged collection. `executeRemoveCollection` cannot run while `activeLoansOfCollection > 0`, so a rugged collection's loans must wind down before the collection can be delisted. Lenders may be unable to recover NFTs (lost) AND have no fallback to recover principal if liquidation outbound fails.

**Severity:** Informational — purely admin diligence + collection upgrade risk; nothing the contract can structurally close beyond what it already does.

---

### F-14-3 (NOTE) — Origination-fee policy honors cuts but not raises; min-APR policy honors neither

**Path:** lines 519-529 (origination fee fairness path) vs 419-420 (min-apr at create only)

`acceptOffer`'s origination-fee logic actively re-computes against the live `originationFeeBps` and refunds the borrower the delta when the live rate is LOWER than the offer's snapshot. This is borrower-friendly (delivers fee cuts to the borrower at acceptance time). Admins raising the fee do NOT retroactively tax pending offers — snapshot wins.

The min-APR policy is asymmetric: the offer is gated on `_aprBps >= minAprBps` only at `createOffer`. If admin LOWERS `minAprBps`, an existing offer at the higher pre-cut rate is unaffected (correct — protects lender). If admin RAISES `minAprBps`, an existing offer at the (now-too-low) rate remains accepatable indefinitely. This is the natural snapshot semantics for offer terms, but it's worth noting that origination fee and min-APR have inconsistent fairness semantics.

**Severity:** Informational. Not exploitable; design choice.

---

### F-14-4 (NOTE) — Interest accrues during sequencer outage time

**Path:** `pauseAdjustedElapsed` (line 958) uses `pause` time only; outage-buffer extensions are deadline-only

`getSequencerOutageBuffer` extends `effectiveDeadline + GRACE_PERIOD`, so a borrower whose repay tx queued during an outage has post-resume time to land. But `pauseAdjustedElapsed` (which feeds `calculateLoanInterest`) does NOT subtract outage time — only pause time. So during a multi-hour sequencer outage, interest continues to accrue against the borrower even though they could not transact. This is symmetric (lender also could not claimDefault) but not borrower-friendly.

This matches the documented intent of pause vs outage handling — pause is admin-controlled and explicit; outage is external — but a defaulted borrower might argue they paid extra interest for time they had no way to act in. Aave V3 takes the same stance (interest accrues during outages). 

**Severity:** Informational. Industry-standard.

---

### F-14-5 (NOTE) — Lender-as-borrower wash-trade vector for off-protocol incentives

**Path:** flow across `createOffer` → `acceptOffer` → `claimDefault`

Same address can lend to itself: `createOffer` deposits 1 ETH; same address calls `acceptOffer` paying NFT escrow; receives 1 ETH back as principal; lets loan default; calls `claimDefault` to receive NFT back. Net economic cost = `originationFee + gas + protocolFee on min-interest floor` (only if it doesn't default before MIN_INTEREST_DURATION). Minimum cost when defaulting: `originationFee + gas` (claimDefault charges no protocol fee).

This is not a contract bug — the lender lost the principal-as-deposit, then got it back as principal-released. Net flow within the protocol = 0 (modulo origination + gas).

But: this creates a free wash-trade primitive for off-protocol incentive programs that look at TVL flows, loan counts, or "active loans of collection X" metrics. With `originationFeeBps == 0` (current state) the cost is just gas. If the protocol ever runs incentive programs keyed on lending volume or loan count, this primitive can be cheaply exploited.

**Severity:** Note. Mitigation: any future incentive program should source its volume from settled-with-distinct-counterparty loans, or apply a non-zero `originationFeeBps` to make wash-trades costly.

---

### F-14-6 (NOTE) — Stuck collateral has no admin rescue path

**Path:** `claimStuckCollateral` (line 805) — only callable by the recorded recipient

If the original recipient (borrower or lender) loses their key after a stuck-event, the NFT is permanently locked in the contract. There is no admin override (intentional — the comment block at lines 794-803 documents this design choice).

If the loan was a default (recipient = lender) and the lender's key is lost, the NFT is permanently locked in the contract. The collateral collection can never have its `activeLoansOfCollection` decrement past this loan (wait — actually `claimDefault` decrements at line 768-770 BEFORE setting the stuck flag, so the counter is correct; the collection CAN be removed even with stuck NFTs lingering. Verified safe.)

**Severity:** Informational. Documented design — no admin custodial risk by intent.

---

### F-14-7 (NOTE) — `_safeOutboundTransfer` path: token burned during transfer is unrecoverable

**Path:** `_safeOutboundTransfer` lines 862-877

If a malicious collection burns the tokenId during the transferFrom call:
- `safeTransferFromBounded` returns true (call did not revert).
- `safeOwnerOfBounded` reverts on the burned id → `ownerOk == false` → `moved = false`.
- Caller marks `stuckCollateralRecipient[loanId]`.
- Future `claimStuckCollateral` calls `_safeOutboundTransfer` again → ownerOf still reverts → returns false → `StuckCollateralStillStuck` revert forever.

The recipient has a non-recoverable claim that can't be retired. No money loss (money flowed correctly) — only the NFT is gone. The `CollateralRedirected` event fires on the FIRST attempt (line 875-877), giving off-chain monitoring a forensic breadcrumb. But the on-chain state shows a permanently stuck mapping.

**Severity:** Informational. Same class as F-14-6 — collection-side hostility that the contract structurally can't fix.

---

### F-14-8 (NOTE) — `safeOwnerOfBounded` 30k gas limit may starve unusual but honest collections

**Path:** `lib/SafeERC721Call.sol:75-92`

The 30k gas budget on `ownerOf` was chosen to neutralize the GAS-01 returndata bomb. Standard ERC721 `ownerOf` consumes ~3k gas (single SLOAD). But an unusual collection that lazily computes ownership (e.g., ERC721A's `_ownershipOf` has a worst-case loop back through multiple slots looking for the first non-zero owner; or a wrapped-NFT that delegates to the underlying collection's ownerOf) might exceed 30k for certain token IDs.

If `safeOwnerOfBounded` returns `ok == false` due to gas exhaustion (not revert by the collection), `_safeOutboundTransfer` returns false → caller marks stuck. The stuck path is correct, but the user experiences an unexpected stuck-recovery flow on a honest-but-gas-heavy collection. This is rare in practice (most ERC721A `_ownershipOf` queries land in <30k for reasonably-mintered tokens), but worth noting as a tail-risk.

**Severity:** Informational. Operational note — admins should sanity-check gas of `ownerOf` on any candidate collection before whitelisting.

---

### F-14-9 (NOTE) — `acceptOffer` does not implement `onERC721Received`; deposits via `safeTransferFrom` revert

**Path:** lines 581 (uses `transferFrom`, not `safeTransferFrom`)

Confirmed: contract does NOT implement `IERC721Receiver`. `acceptOffer` calls `transferFrom`, which is OK for the contract-as-receiver. But any external call doing `nft.safeTransferFrom(borrower, contract, tokenId)` directly would REVERT because the receiver lacks `onERC721Received`. This is protective: it prevents a borrower from accidentally dumping NFTs into the contract outside the loan flow.

But: what about NFTs that ONLY support `safeTransferFrom` (e.g., a hypothetical strict-ERC721 that disables raw `transferFrom`)? The escrow at line 581 would revert at acceptOffer. The borrower's loan acceptance just fails — no money moved, no NFT moved, offer remains active. SAFE.

A more concerning case: an NFT collection whose `transferFrom` internally calls `onERC721Received` on the recipient (some non-spec implementations do). The receiver (this contract) doesn't implement it → revert. Same outcome — acceptOffer reverts. SAFE.

**Severity:** None. Worth documenting that the contract is `transferFrom`-only.

---

### F-14-10 (NOTE) — Hardcoded JBAC / Nakamigos / GNSS Art addresses in constructor

**Path:** lines 360-362

```
whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art
```

Pre-listed at deploy without ERC165 check (the check is only in `proposeWhitelistCollection` at line 1029, not in the constructor). If any of these three addresses is wrong (typo, wrong-chain address, sunsetted contract), the deploy is bricked for that collection's loans. There's no constructor-time validation. A subsequent removal still goes through the 24h timelock + active-loans gate.

This is purely operational — admin's responsibility — but worth flagging as an asymmetry: post-deploy whitelist additions get ERC165 validation; constructor-time additions do not.

**Severity:** Informational. Suggested mitigation: also call `code.length > 0` and `supportsInterface(0x80ac58cd)` in the constructor for parity.

---

## Dead-end probes (no finding)

The following lenses were probed and found safe:

- **Repay-vs-liquidate race (Lens 11):** boundary `block.timestamp == effectiveDeadline + GRACE + outageBuffer` is exclusive (repay reverts at `>`, claim reverts at `<=`). Clean handoff. No double-spend.
- **Approval residue post-repay (Lens 18):** ERC721 transfers clear per-token approvals; collection-wide approvals are scope-limited to this contract's own functions which are all permission-gated.
- **Reentrancy via NFT collection during inbound `transferFrom` (Lens 36):** `acceptOffer` is `nonReentrant`; post-condition `ownerOf == address(this)` catches silent no-op; `CollateralNotEscrowed` revert closes the redirect-but-not-revert vector.
- **Reentrancy into `claimStuckCollateral` from a malicious collection's transfer callback (Lens 16):** `msg.sender != recipient` check prevents the collection (which would be msg.sender of any reentrant call) from impersonating the rightful recipient.
- **Force-tag a sold NFT via pre-existing approval (Lens 8):** `acceptOffer` checks `ownerOf == msg.sender` immediately before `transferFrom`. Borrower must currently own.
- **ERC721A batch-mint two-ids-one-loan (Lens 9):** offer struct stores a specific `tokenId`; loan inherits it; the same tokenId cannot be in two active loans because the contract owns the token after escrow.
- **0% APR / 1-second flash-borrow (Lens — DEEP-LD2-H2):** `MIN_INTEREST_PRINCIPAL_BPS = 5` flat floor + `MIN_INTEREST_DURATION = 1 day` floor, plus `block.timestamp == startTime` revert. Closed.
- **MIN_PRINCIPAL = 0.001 ETH (LD-04):** floor in place; sub-MIN principals rejected at `createOffer`.
- **Reentrancy via WETH fallback (Lens 24, 41):** 10k gas stipend + immutable `weth` address; cross-contract reentry impossible.
- **Pause-induced free interest (Lens 15):** `elapsed = 0` triggers floor-skip; no exploit.
- **`pausedDurationAtStart` invariant (Lens — LD3-M4):** `PauseInvariantViolated` revert on inversion; storage-corruption fail-loud.
- **Active loans counter underflow on settlement (Lens 38):** `if (counter > 0)` guard on both repay and claim decrement paths.
- **Removal cancel-rate-limit brick scenarios (Lens 22):** still-live carve-out + LD3-M5 gate-before-execute prevent the cancel-budget DOS.
- **Sequencer feed misconfiguration with future-dated `updatedAt` / `startedAt` (Lens — v3-LIB-M1):** library returns typed errors; no `Panic(0x11)` underflow path.
- **Floor-price oracle manipulation (Lens 10):** N/A — contract uses NO oracle for valuation; lender sets principal.
- **Self-liquidation profit (Lens 4):** lender can lend to self but no profit beyond avoiding their own interest payment (round-trips own ETH).
- **Borrower extends grace by repaying $1 (Lens 3):** N/A — `repayLoan` requires full `principal + interest`; no partial repay path.
- **ERC4906 metadata-update during loan (Lens 32):** lender-side underwriting risk; no contract-side accounting depends on metadata.

---

## Summary

`TegridyNFTLending.sol` is a well-hardened contract. The audit history is dense (LD-04, DEEP-LD-M6, DEEP-LD-M8, DEEP-LD-M10, DEEP-LD-H1/H2, DEEP-LD2-H1/H2/M2/M3, LD3-M1/M4/M5, BATCH-I M10, BATCH-L3 M4, FRESH-EYES H-3, LD-NEW-H2, GAS-01, NFTLEND-WL-1, PASS7-NFTLENDING-01/02, V2-NFTPOOL-01, BATCH-D H13, etc.), and the code reflects defense-in-depth:

- CEI compliance on all state-mutating paths (repay, claim, accept, cancel).
- `nonReentrant` everywhere external calls happen, except `claimStuckCollateral` where the rationale is documented and the `msg.sender == recipient` gate provides equivalent protection.
- Bounded-returndata helpers neutralize GAS-01 on hostile whitelisted collections.
- Post-condition `ownerOf` checks on both inbound (CollateralNotEscrowed) and outbound (LD-NEW-H2 / `_safeOutboundTransfer`) NFT transfers.
- Symmetric pause + sequencer-outage handling between borrower-repay and lender-claim paths.
- Per-collection cancel rate-limit + still-live carve-out prevents both bricking AND infinite-stalling of removal proposals.

**No code-fixable high-severity bug identified.** All findings above are informational or operational. The single recommendation worth productizing is **F-14-1**: add a deploy-time guard against L2 deployments that forget to set the sequencer feed.

Path to file: `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/findings/agent_14_nftlending.md`
