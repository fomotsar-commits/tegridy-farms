# Slither static-analysis triage — 2026-05-02

Slither v0.11.5 ran across `contracts/src/**` (deps in `lib/` filtered;
`naming-convention,solc-version,pragma,low-level-calls,assembly,similar-names,too-many-digits,constable-states,external-function,incorrect-shift,dead-code` excluded).

**Result: 595 findings, 0 actionable security gaps.**

Distribution by detector and triage rationale:

| Detector                  | Verdict          | Reason                                                                                                                          |
|---------------------------|------------------|---------------------------------------------------------------------------------------------------------------------------------|
| arbitrary-send-eth        | False positive   | All recipients are gated upstream (proposal/owner/fixed-address routing); slither cannot see the broader auth flow.             |
| weak-prng                 | False positive   | `block.timestamp % 2**32` is a uint32 truncation in TWAP windows, not a randomness source.                                      |
| reentrancy-balance        | False positive   | Every flagged FoT swap path lives behind `nonReentrant`; the post-swap balance delta is the correct FoT idiom.                  |
| reentrancy-eth / no-eth   | False positive   | All flagged paths carry `nonReentrant`; cross-iteration claimed-flag writes precede the gas-capped ETH send (CEI).              |
| reentrancy-events/benign  | False positive   | Same `nonReentrant` coverage; events-after-call is informational.                                                               |
| return-bomb               | False positive   | Either `(bool,)` (no decoding) or `staticcall{gas:30k}` which bounds copy-back size to ~4 KB.                                   |
| unused-return             | False positive   | Solidity destructuring of multi-field structs (`(amt,,,,,,)`); the `ownerOf(_tokenId)` call in NFTLending is revert-only.       |
| uninitialized-state       | False positive   | Mappings/dynamic arrays grow at runtime; `_deprecated_paidFeeRate_slot` is intentional storage layout pinning.                  |
| uninitialized-local       | False positive   | Solidity initializes locals to zero/empty; the flagged vars use that default semantically.                                      |
| missing-zero-check        | False positive   | All flagged params are intentionally zero-permitting (sequencer feed disable, guardian disable, derived-from-pair token addrs). |
| incorrect-equality        | False positive   | `== 0` early-exits on uint256 are the standard idiom; uint equality with 0 is well-defined.                                     |
| timestamp                 | False positive   | Deliberate use of `block.timestamp` for cooldowns, deadlines, TWAP windows.                                                     |
| divide-before-multiply    | False positive   | All cases are TWAP/Q112 fixed-point math where the division is the precision floor, not a precision-loss bug.                   |
| missing-inheritance       | Cosmetic         | Three contracts could inherit interfaces declared in sibling files. Type-safety improvement, not a security gap.                |
| events-maths              | Cosmetic         | TegridyStaking apply* setters don't emit; the wired admin contract DOES emit on its execute side (canonical event source).      |
| immutable-states          | Cosmetic         | TegridyPair.factory + Toweli._initialMintDone could be `immutable` (gas saving).                                                |
| boolean-equal             | Cosmetic         | One `== false` use; readability nit.                                                                                            |
| calls-loop                | False positive   | All loops are bounded by epoch ring buffers; gas cost is amortized at known cap.                                                |
| costly-loop               | Cosmetic         | Storage writes inside loops are functionally required (per-token settlement).                                                   |
| cyclomatic-complexity     | Cosmetic         | Style-only.                                                                                                                     |
| unindexed-event-address   | Cosmetic         | One event lacks an `indexed` qualifier on an address topic.                                                                     |

No fixes applied from this pass. Findings are catalogued for completeness;
the actionable work from earlier passes (PASS1–PASS4 + L-2/L-4/M-6/H-1-2 in
this commit) is what the slither pass was meant to backstop, and it does
not surface anything new.
