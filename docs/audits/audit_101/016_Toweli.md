# Agent 016 — Toweli.sol Forensic Audit

**Target:** `contracts/src/Toweli.sol` (43 lines)
**Test:** `contracts/test/Toweli.t.sol` (195 lines)
**Pragma:** `^0.8.26`
**Inherits:** OZ `ERC20`, `ERC20Permit` (no custom logic)
**Mode:** AUDIT-ONLY — no source edits.

---

## Summary

Toweli is a deliberately minimal, fixed-supply ERC-20 + EIP-2612 permit token. The contract body is one constructor that mints `1_000_000_000 ether` to a non-zero recipient. There is no owner, no mint, no burn, no pause, no blocklist, no fee/tax, no hooks, no snapshot, no voting layer. As a result, almost every threat in the hunt list is *structurally absent* (HIGH/MEDIUM/LOW are mostly N/A — that is the finding). Risk surface is reduced to the inherited OZ implementations + EIP-712 domain construction.

Counts: HIGH 0 | MEDIUM 0 | LOW 2 | INFO 6 | Test gaps 4

---

## HIGH

*(none)*

The threats listed are not reachable in this contract:
- **Tax/fee skim/sync abuse**: no fee logic exists. `_update` is OZ default; Pair.skim/sync cannot be exploited because there is no balance reservation, no auto-LP, no fee-on-transfer.
- **Blacklist abuse**: no blocklist surface exists (`test_noBlocklist`-style coverage missing but irrelevant — no selector to attack).
- **Mint privilege escalation**: `_mint` is called once in the constructor only; OZ's `_mint` is `internal`; there is no public mint and no role/owner that could be added later (contract is not upgradeable, no proxy, no `onlyOwner`).
- **Supply cap bypass**: `TOTAL_SUPPLY` is `constant`; the only mint site is the constructor; any bypass would require redeploying a different contract.
- **Transfer hook reentrancy**: no `_beforeTokenTransfer` / `_afterTokenTransfer` / `_update` override; OZ default has no external calls.

## MEDIUM

*(none)*

- **Owner-only setters that should be timelocked**: there are no setters at all. No fee whitelist, no fee config, no router whitelist.
- **totalSupply drift vs balances**: OZ ERC20 `_update` keeps `_totalSupply` in lockstep with balances; no override exists to break that invariant.

## LOW

### L-01 — Permit DOMAIN_SEPARATOR rebuilt on chainid change but no EIP-5267 / explicit cross-chain replay test
**File:** `contracts/src/Toweli.sol:27` (inherits `ERC20Permit`)
**Detail:** OZ `ERC20Permit` (via `EIP712`) caches the domain separator at construction and rebuilds it when `block.chainid != _CACHED_CHAIN_ID`. This is the correct mitigation for hard-forks and cross-chain replays. However, the test suite never exercises the chainid-divergence path (`vm.chainId(...)`), so a regression that broke the rebuild (e.g. an upgrade to a future OZ version that changed semantics) would not be caught locally. Risk is informational — current OZ release (`>=4.6`) is correct.
**Recommendation (audit-only note):** add a test that signs a permit, calls `vm.chainId(newId)`, and asserts the old signature reverts.

### L-02 — Recipient is unsanity-checked beyond non-zero
**File:** `contracts/src/Toweli.sol:35-41`
**Detail:** Constructor only rejects `address(0)`. If `recipient` is the deployer's EOA by mistake (rather than the multisig the docstring expects at line 32), the entire 1B supply is held by an EOA. There is no on-chain enforcement that `recipient.code.length > 0` or that it matches a published multisig. This is a deployment-procedure concern, not a code bug, but worth flagging because the contract has no recovery path (no owner, no admin).
**Recommendation:** off-chain — verify `recipient` matches the multisig in `TOKENOMICS.md` before broadcast.

## INFO

### I-01 — Fixed-supply / no-admin design is self-documenting and matches tests
**File:** `Toweli.sol:7-26` (NatSpec) vs `Toweli.t.sol:74-100`
The four "no admin surface" tests (`test_noMintFunction`, `test_noBurnFunction`, `test_noOwnerFunction`, `test_noPauseFunction`) confirm by selector probe that the contract has no rug surface. Good practice.

### I-02 — Decimals immutability
**File:** `Toweli.sol:27` — relies on OZ default `decimals() == 18`; not overridden. Test asserts at `Toweli.t.sol:48`. Compliant.

### I-03 — ERC-20 return-value compliance
Inherits OZ `ERC20`, which always returns `true` from `transfer` / `transferFrom` / `approve`. No custom return-value handling. Compliant.

### I-04 — No snapshot / voting layer
`ERC20Votes` / `ERC20Snapshot` are NOT inherited. Despite the docstring calling Toweli a "governance token" (line 7), there is no on-chain voting power tracking. Governance must therefore use an external snapshot tool (Snapshot.org) or a wrapper — there is no double-counting risk because there is no counting at all. *Design choice*, but worth flagging because the name implies otherwise.

### I-05 — `TOTAL_SUPPLY` uses `ether` literal
**File:** `Toweli.sol:29` — `1_000_000_000 ether` = `1e27`. Correct for 18 decimals; readable. No issue.

### I-06 — Fee whitelist drift / fee-on-transfer
N/A — no fee logic; transfers move full amount. Pair.skim/sync exploits that rely on FoT delta misreporting are not reachable.

---

## Test Gaps

| # | Gap | Location |
|---|-----|----------|
| TG-1 | No cross-chain replay test (chainid switch) for permit signatures. | `Toweli.t.sol:163-176` |
| TG-2 | No fuzz test on `transfer` / `transferFrom` to assert `sum(balances) == totalSupply` invariant under random sequences. | `Toweli.t.sol` (absent) |
| TG-3 | No `EIP712Domain` field assertions (`name`, `version`, `chainId`, `verifyingContract`). Permit could be silently broken by an OZ upgrade if version string changed. | `Toweli.t.sol` (absent) |
| TG-4 | No invariant test that `address(token).code.length` has no `mint`, `burn`, `pause`, `owner`, `blocklist`, `setFee`, `setTaxWallet` selectors — only positive-call checks for four of them. Comprehensive selector-deny list missing. | `Toweli.t.sol:74-100` |

---

## Cross-references

- Vanity address `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` is documented at `Toweli.sol:12-14` and tied to `docs/TOKEN_DEPLOY.md` (not in scope this batch).
- Docstring at line 17-19 instructs auditors to prefer Etherscan-verified bytecode if divergence — flag for cross-chain deploys (Base, Arbitrum) where a re-deploy will yield a different bytecode hash.

## Verdict

Toweli is one of the safest contracts in the codebase by virtue of having almost no surface area. No HIGH/MEDIUM findings. Two LOW (one is a test-coverage gap, one a deployment-procedure note). Recommend: keep as-is; add the four test gaps above for defense-in-depth.
