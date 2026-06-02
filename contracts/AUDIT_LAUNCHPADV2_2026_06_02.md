# Launchpad V2 — Pre-Deploy Audit (2026-06-02)

**VERDICT: DEPLOY-READY** — the one MEDIUM finding has been patched (one-line guard + 2 regression tests) and verified; the factory and the clone-init seam are clean.

## Provenance

`TegridyLaunchpadV2` (EIP-1167 clone factory, OZ `Clones`) + `TegridyDropV2` (the cloned
NFT drop that custodies mint ETH + a refund escrow) were **recovered from git** — they had
been audited across prior waves (PR #50's critical+highs, an ownership expiry+cancel fix,
sequencer/spot-price fixes) and then **cut from the MVP** at commit `10e1dcc`, not removed
for being broken. The most-hardened version (`1f4197d`, 2026-05-31) was restored, confirmed
to **compile against current bases**, and its recovered test suites pass:
**Drop 65/65, Factory 12/12, Supply-conservation invariants 5/5** (0 reverts across ~25k
fuzzed calls). Its create-collection wizard frontend is already built and matches these
contracts ABI-for-ABI. It was then **re-audited fresh** (adversarial passes on the drop, the
factory, and the factory↔drop clone-init seam, each finding verified against real code).

## Remediation applied 2026-06-02

### MEDIUM (FIXED) — `DUTCH_AUCTION → PUBLIC` toggle with `mintPrice == 0` enabled free mints

- **File:** `contracts/src/TegridyDropV2.sol` — `setMintPhase`.
- **Issue:** a dutch-auction drop legitimately runs with storage `mintPrice == 0` (price comes
  from the curve via `_dutchAuctionPrice()`). The H19 "once any token is minted, `mintPrice`
  is monotonically non-zero" invariant was enforced **only** in `proposeMintPrice`/
  `executeMintPrice`. `setMintPhase` guarded `ALLOWLIST` (`merkleRoot != 0`) and `DUTCH_AUCTION`
  (`dutchDuration != 0`) but had **no** `mintPrice > 0` guard for `PUBLIC`. So after real paid
  dutch mints (`totalSupply > 0`), an owner could flip to `PUBLIC` where `mintPrice == 0` →
  `totalCost == 0` → mints become **free**, rugging the dutch bidders. Owner-gated (the exact
  threat model the propose/execute timelock machinery exists to contain) but instant
  (`setMintPhase` is not timelocked).
- **Fix:** mirror the existing phase guards —
  `if (phase == MintPhase.PUBLIC && mintPrice == 0 && totalSupply > 0) revert ZeroPricePostMint();`
  This extends the H19 invariant across the phase machine while still allowing intentionally
  free drops that start at `totalSupply == 0`.
- **Regression tests added** (`test/TegridyDropV2.t.sol`):
  `test_setMintPhase_revertsPublicZeroPriceAfterMint` (dutch mint → flip to PUBLIC reverts
  `ZeroPricePostMint`) and `test_setMintPhase_allowsPublicZeroPriceBeforeAnyMint` (genesis free
  drop still allowed).
- **Verification:** `forge build` OK (TegridyDropV2 21,489 B / TegridyLaunchpadV2 9,184 B —
  both under EIP-170); `forge test` green — TegridyDropV2 **29/29** (incl. both new tests),
  Factory 12/12, invariants 5/5.

## Key attacker scenarios checked (all SAFE)

**Clone-init hijack / template lock — the headline risk for a clone factory:**
- Direct `initialize()` on the `dropTemplate` → BLOCKED: constructor `_disableInitializers()`
  sets the OZ initialized flag to `type(uint64).max`; the template can never be initialized.
- Front-running `initialize()` on a fresh clone → BLOCKED: `cloneDeterministic` + `initialize()`
  are atomic in one tx; per-creator nonce incremented **before** deploy.
- Address-squat / pre-occupation → BLOCKED: salt =
  `keccak256(abi.encode(chainid, factory, msg.sender, perCreatorNonce, name, symbol))` binds
  `msg.sender`, uses `abi.encode` (no `encodePacked` collision class), and binds chainid + factory.
- External-CREATE2 squat / metamorphic redeploy → BLOCKED: clone address keyed to the factory
  as deployer; EIP-1167 clones have no `SELFDESTRUCT`; `cloneDeterministic` reverts on reuse.
- Re-init of a live clone → BLOCKED: `initializer` one-shot; no `reinitializer` exists.

**Refund-escrow / mint-ETH custody — SAFE:** `cancelSale` gated to `totalSupply == 0` makes the
refund path structurally dead; `withdraw` is `onlyOwner`+`nonReentrant`, gated to `CLOSED ||
soldOut`, distributes `min(totalProceeds, balance)` and zeroes `totalProceeds` one-shot; donations
are not paid platform fees; all value paths `nonReentrant` + CEI + 30k-gas WETH stipend.

**Mint accounting — SAFE:** supply cap, `MAX_MINT_PER_TX = 50`, per-wallet cap; exact payment with
overpayment refund; merkle leaf double-hash binds `address(this) + msg.sender + allowedAmount`
(no cross-clone/phase replay); dutch price monotonic, no underflow, sequencer-gated at mint with a
non-reverting sentinel for indexers.

**Factory-level — CLEAN:** InitParams bounded in the factory **and** re-validated in `initialize`
(caps live in the drop), so even a factory-bypassing direct clone is bounded; `protocolFeeBps`
behind a 48h timelock with a `MAX_PROTOCOL_FEE_BPS = 1000` ceiling; `acceptOwnership` flushes
pending proposals; factory custodies no value; enumeration is O(1) writes + a ≤1000-bounded
paginated view.

## Refuted (NOT issues)
- Factory **stale code comment** (claims a `nonReentrant` the function doesn't carry) — verified
  non-exploitable; informational only. *(Cosmetic cleanup left as an optional follow-up.)*
- Clone-init seam **test-coverage gap** (no explicit assert that `template.initialize()` reverts) —
  behavior is guaranteed by audited OZ library code; not a vulnerability.

## Deploy (operator)
`contracts/script/DeployLaunchpadV2.s.sol` deploys `TegridyLaunchpadV2` (which deploys the
`TegridyDropV2` template in its constructor). After deploy, set `TEGRIDY_LAUNCHPAD_V2_ADDRESS`
in `frontend/src/lib/constants.ts` (the wizard auto-un-gates). Mainnet deploy stays an operator/
multisig action per the project security rule. Sequencer feed = `address(0)` for the Ethereum
mainnet deployment (no L2 sequencer).
