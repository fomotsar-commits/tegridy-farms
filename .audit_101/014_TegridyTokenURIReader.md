# Agent 014 — TegridyTokenURIReader.sol Forensic Audit

**Target:** `contracts/src/TegridyTokenURIReader.sol` (158 LOC)
**Test:** `contracts/test/TegridyTokenURIReader.t.sol` (288 LOC, 16 tests)
**Audit date:** 2026-04-25
**Wiring context:** Standalone view contract. NOT wired into `TegridyStaking.tokenURI` (staking still uses base ERC721 + baseURI per src:1465). Reader is consumed off-chain (frontend / Etherscan-style indexers) by calling `reader.tokenURI(tokenId)` directly. No on-chain ERC721 returns this string today.

---

## Hunt Matrix

| Vector | Status | Severity |
|---|---|---|
| Gas-grief via large on-chain SVG | Mitigated by view-only / off-chain consumption | **INFO-1** |
| Reentrancy via external NFT calls | N/A — only calls `staking.positions()` (view) | none |
| Malicious tokenURI injection (`javascript:` data URLs) | N/A — output is fully constructed in-contract from typed numerics; no user-controlled string fields | none |
| JSON-injection in name/description | Confirmed clean — no string inputs, all data is typed (uint/bool) | none |
| Base64 padding errors | OZ Base64 implementation; no custom padding logic | none (re. SVG); test-side decoder has padding handling — see **LOW-2** |
| View-function gas DoS | Possible if called from on-chain consumer w/ block gas budget; safe off-chain | **MEDIUM-1** |
| Owner-set image-base front-run | N/A — no owner, no setters, no mutable state | none |
| Supplyless ERC721 bypass | Confirmed — reader does NOT verify token exists; renders zeros for non-existent IDs (test_tokenURI_noPositionRendersZero) | **MEDIUM-2** |

---

## HIGH

_None._

The contract is a stateless view layer with no privileged functions, no external token transfers, no NFT callbacks, no user-controlled string concatenation. The classic SVG-metadata exploit surfaces (data-URL injection, owner art-base front-run, reentrant minting hooks) do not exist here.

---

## MEDIUM

### MEDIUM-1 — `tokenURI()` is unbounded view; ~7-10kB output may exceed cross-contract gas limit if any on-chain consumer ever calls it

**Location:** `tokenURI()` L41-52, with `_buildSVG` L86-110, `_buildSVGBody` L112-137, `_buildJSON` L139-157.

**Finding:** Every invocation:
1. Reads `positions(tokenId)` (1 SLOAD-bundle on the staking contract).
2. Calls `_formatAmount`, `_boostDisplay`, `_lockStatus` repeatedly (3× `_formatAmount`, 3× `_boostDisplay`, 2× `_lockStatus`) — string-concat in EVM is O(n) memory copy each time.
3. Builds an SVG string of ~1.5–2 kB.
4. Base64-encodes it (4/3 expansion → ~2.5 kB).
5. Embeds it in JSON, then Base64-encodes the JSON again → final string ~5–7 kB.

While `view` calls have no gas cost off-chain (RPC `eth_call`), if any future contract (marketplace, lending vault, governance display) ever calls `staking.tokenURI()` and that delegates to this reader, the cost from string.concat allocations + 2 layers of Base64 + repeated formatter calls (each runs the helpers TWICE — once in `_buildSVG` and once in `_buildJSON`) can push the call over the 30M block limit on busy chains, or hit the EIP-150 63/64 sub-call limit when nested.

**Severity rationale:** MEDIUM because:
- Currently reader is OFF-CHAIN only (staking.tokenURI returns "" + baseURI per src:1465-1466), so impact is theoretical today.
- BUT there is no comment in the code preventing a future PR from wiring `staking.tokenURI` to call this reader — and the gas profile would silently DoS any on-chain consumer.

**Recommended fix:**
- Hoist `_formatAmount(amount)`, `_boostDisplay(boostBps)`, `_lockStatus(...)` into local strings in `tokenURI()` and pass them down — avoid duplicate computation. Currently `_formatAmount` is called in `_buildSVG` (via `amountStr`) AND directly in `_buildJSON` L146, L149. Same for `_boostDisplay` (L91, L146, L150) and `_lockStatus` (L93, L152). That's roughly 2× wasted formatter work per call.
- Add a NatSpec line: `/// @notice Off-chain consumption only; gas profile not bounded.`

### MEDIUM-2 — Reader does not verify token existence; renders synthetic zeros for any tokenId

**Location:** `tokenURI()` L41-52 + `staking.positions(tokenId)` always returns zero-struct on missing key (Solidity mapping default).

**Finding:** `test_tokenURI_noPositionRendersZero` (test L239-246) explicitly documents this: calling `reader.tokenURI(999)` for a non-existent token returns a fully-formed JSON with `"value":"0 TOWELI"`. The reader has no `require(staking.ownerOf(tokenId) != address(0))` or equivalent existence check.

**Impact:**
- **Phishing surface:** A scammer can lure a victim to a fake marketplace listing for `tsTOWELI #999999999` (any unminted ID), pull metadata via this reader, and the JSON will render as a real-looking position with 0 TOWELI staked. Combined with social engineering ("rare zero-value commemorative position"), this is a misleading UX.
- **Indexer poisoning:** Any indexer that walks `tokenURI(0..N)` will get valid JSON for every ID, not a revert — making it impossible to distinguish minted vs unminted tokens via metadata alone.
- **ERC721-Metadata spec violation:** EIP-721 requires `tokenURI(_tokenId)` to throw for non-existent NFTs (`MUST throw if `_tokenId` is not a valid NFT`). This reader silently violates that contract.

**Recommended fix:**
```solidity
function tokenURI(uint256 tokenId) external view returns (string memory) {
    address owner = staking.ownerOf(tokenId);   // reverts on non-existent in OZ ERC721
    if (owner == address(0)) revert("nonexistent token");
    // ... rest unchanged
}
```
The `ownerOf` interface method is already declared (L26) but never called.

---

## LOW

### LOW-1 — `_formatAmount` truncates to 2 decimals; sub-cent amounts render as "0"

**Location:** L54-60.

`uint256 frac = (amount % 1e18) / 1e16;` — anything below 0.01 TOWELI (i.e., `< 1e16` wei) drops to `frac == 0` and the helper returns `"0"`. A position of 0.005 TOWELI (5e15 wei) shows as `"0 TOWELI"`. Display issue, not a security one — but **identical to the supplyless bypass output** in MEDIUM-2, compounding the phishing surface.

### LOW-2 — Test-side `Base64Dec._c` returns `0` for any non-base64 character

**Location:** test L278-286.

The test's helper decoder silently maps invalid characters to `0` instead of reverting. If the contract ever produces non-base64 output (it won't today, OZ `Base64.encode` is well-vetted), tests would silently pass with garbage decoded JSON. Defensive only — does not affect production code.

### LOW-3 — `_lockStatus` shows "0h left" when remaining < 1 hour

**Location:** L75-84.

If `remaining < 3600`, `hours_ = 0` → output `"0h left"`. Should fall through to a "<1h" or minutes branch for last-hour positions. Cosmetic.

### LOW-4 — `lockDuration / 86400` integer-truncates non-day-aligned durations

**Location:** L151. A 30-day lock = 2592000s renders as `30`, but a 30.5-day lock would render as `30`. Cosmetic. Only matters if `setLockDuration` ever permits non-day-aligned input (it does not today).

---

## INFO

### INFO-1 — On-chain SVG is reasonably sized (~1.5 kB unencoded, ~5 kB final)

The SVG body has only 12 `<text>` elements + 4 rects + 1 gradient. No `<image>` tags, no external `xlink:href`, no `<foreignObject>`, no `<script>`. Base64-encoding the SVG before embedding eliminates XSS via attribute breakouts. **Output is XSS-safe by construction** — no string field can contain a `"` because all dynamic content is `Strings.toString(uint256)` or hardcoded `"Yes"/"No"/"Auto-Max"/"Flexible"/"Expired"/"Xd left"/"Xh left"`.

### INFO-2 — JSON-injection vector is closed by typed inputs

The contract has zero `string` inputs from users or admins. `name`, `description`, `image`, and all `attributes` values are derived from `uint256/uint16/uint32/uint64/bool` only. Even if `staking.positions()` returned hostile values, the `Strings.toString()` wrapper outputs only `[0-9]+`, which cannot break out of a JSON string literal. **Cannot be JSON-injected.**

### INFO-3 — Reader is decoupled from staking ownership/transfer state

The reader does not check `staking.ownerOf(tokenId)` or compare to anything. Combined with MEDIUM-2, this means even a burned or transferred token still renders the same metadata as long as `positions[tokenId]` retains data. (Burns in TegridyStaking should clear the position struct — verified separately in `_burn` audit; not in scope here.)

### INFO-4 — `block.timestamp` in `_lockStatus` makes `tokenURI` non-deterministic across calls

This is correct/expected — lock status changes over time. Worth flagging only because some indexers cache by `(contract, tokenId)` and may serve stale "5h left" indefinitely. Off-chain concern only.

### INFO-5 — Constructor accepts `address(0)` for staking

`constructor(address _staking) { staking = ITegridyStaking(_staking); }` — no zero-address check. Bricks the contract permanently, but since this is deploy-once and the address is fixed at construction (immutable), incorrect deployment would just produce a non-functional reader. Catchable via deploy script tests.

---

## Test Gaps

The current test suite (16 tests) is solid for **rendering correctness** but misses **adversarial / spec-conformance** scenarios:

1. **No EIP-721 conformance test** — should assert reader reverts (or surfaces an error) for non-existent tokenId. Currently `test_tokenURI_noPositionRendersZero` actively asserts the WRONG behavior (silent zero render) as if it were correct. → tied to MEDIUM-2.
2. **No fuzz test for amount formatting** — `_formatAmount` boundary at `frac == 9` vs `frac == 10` (single vs double digit padding) is only checked at one value (123.45). A `forge fuzz` over `uint256 amount` would catch off-by-ones.
3. **No huge-amount test** — does `_formatAmount(type(uint256).max)` overflow `uint256(whole = max/1e18) ~= 1.15e59`? `Strings.toString` handles full uint256, so no — but worth a regression test.
4. **No XSS-payload-as-tokenId test** — tokenId is `uint256`, so this is unreachable, but a regression test that fuzzes tokenId and grep-checks the output for `<script` / `javascript:` / `</svg` would harden against future refactors that introduce string fields.
5. **No gas-bound test** — `vm.snapshotGasCost(reader.tokenURI(1))` to lock in current cost, so future PRs that double-encode or add fields don't silently regress. Important for MEDIUM-1.
6. **No JSON-validity test** — current `_contains` checks individual substrings but never validates the JSON parses. A `vm.parseJson(json)` cheatcode would catch missing/extra commas, unclosed quotes, etc. (e.g., if `_buildJSON` L146-155 ever loses a comma).
7. **No SVG-validity test** — equivalent: parse SVG with `vm.ffi(["xmllint", "--noout"])` to catch unclosed tags.
8. **No reentrancy test for malicious staking** — although unlikely in production, a mock `IStaking` whose `positions()` reenters via a fallback could verify the reader handles it gracefully (it should, since it makes only one call and uses no state).
9. **No 4-year-max-lock boundary test** — `_formatDays(uint32.max)` = `49710d` — verify Strings.toString handles 5-digit days cleanly.
10. **No leading-zero test for `_boostDisplay`** — `_boostDisplay(10005)` should render `1.00x` (frac=0 returns whole+"x") but `_boostDisplay(10050)` should render `1.00x` because frac=0 (50/100=0)... actually L69 `frac = (bps % 10000) / 100`, so 10050 → frac = 50/100 = 0 → returns "1x". This is the **only known display bug** per the helper logic — test would have caught it. (Not exploitable, just wrong.)

---

## Cross-Reference Notes

- The reader's `ITegridyStaking.Position` struct (L8-18) is **outdated**: TegridyStaking's actual struct (src:95-110) includes `jbacTokenId` + `jbacDeposited`. The reader interface adds these to `positions()` return tuple (L20-25) ✓ but leaves the `Position` struct definition stale at 9 fields. Cosmetic — the struct is unused since the reader calls `positions()` via the function tuple, not via `Position`. Could confuse future maintainers.
- `TegridyStaking.tokenURI` (src:1465) does NOT delegate to this reader. Wiring is purely off-chain. If someone later wires `staking.tokenURI = reader.tokenURI`, MEDIUM-1 becomes HIGH (cross-contract gas DoS on every marketplace render).

---

## Summary

- 0 HIGH
- 2 MEDIUM (gas profile if ever wired on-chain; supplyless rendering / EIP-721 violation)
- 4 LOW
- 5 INFO
- 10 test-gap items

Top fix priority: add `ownerOf` existence check in `tokenURI()` (closes MEDIUM-2 and aligns with EIP-721); hoist formatter calls to single execution per `tokenURI` (mitigates MEDIUM-1 ~50% gas reduction).
