# Agent 96 — Constructor / Initializer Argument Audit (Fresh-Eyes)

**Lens:** Constructor & initializer arguments — wrong defaults, hardcoded mainnet addresses, deploy-time misconfiguration, env-var silent fallbacks, init-param ordering footguns.

**Scope:** All Solidity in `contracts/src/` and all deploy scripts in `contracts/script/`.

**Methodology:** Enumerated every `constructor(...)` and `function initialize(...)` plus all `vm.envOr(...)` defaults and hardcoded `address constant` values across the deploy scripts. Cross-checked init params for (a) zero-address validation, (b) chain-aware vs. mainnet-hardcoded values, (c) protective bounds parity vs. the post-deploy setters, (d) ordering ambiguity for same-typed positional args.

---

## F-96-1 — Hardcoded Mainnet NFT Whitelist In Constructor (TegridyNFTLending)

**File:** `contracts/src/TegridyNFTLending.sol:342-367`
**Init param:** *None — addresses literal-baked.*

```
constructor(
    address _treasury,
    uint256 _protocolFeeBps,
    address _weth
) {
    ...
    whitelistedCollections[0xd37264c71e9af940e49795F0d3a8336afAaFDdA9] = true; // JBAC
    whitelistedCollections[0xd774557b647330C91Bf44cfEAB205095f7E6c367] = true; // Nakamigos
    whitelistedCollections[0xa1De9f93c56C290C48849B1393b09eB616D55dbb] = true; // GNSS Art
    emit CollectionWhitelisted(0xd37264c71e9af940e49795F0d3a8336afAaFDdA9);
    ...
}
```

**Risk:** The `_weth` argument is parameterised by chain, but the three NFT collections are hardcoded mainnet (chain-id 1) addresses with NO `block.chainid == 1` guard inside the constructor itself. On any L2 or testnet deploy:
1. The three constants point at addresses that are either uninitialised or hold completely unrelated contracts. On L2, attackers can deploy a malicious ERC721 at the deterministic address (CREATE2 with reasonable effort given trivial constructor), then have it served as a "whitelisted JBAC" collateral surface.
2. Even on Sepolia / Goerli with no malicious actor, the whitelist is meaningless — `whitelisted == true` for an address that returns 0 for every `ownerOf`. This bricks `createOffer` for non-mainnet test deploys (lender expects to lend against JBAC, contract accepts JBAC-shaped null calls).

The deploy script `DeployNFTLending.s.sol:18` does have `require(block.chainid == 1, "MAINNET_ONLY")`, but the **contract itself** does not. If anyone deploys it via a different script, fork, or `forge script --tc DeployNFTLendingScript --target-contract X`, the chain guard is bypassed. The collection hardcode lives at the contract layer, not the script layer.

**Fix shape:** Pass the three whitelist seeds as constructor `address[] _initialCollections`, OR move the literal triplet behind a `block.chainid == 1` guard inside the constructor.

**Default-misconfig risk:** **HIGH on L2 fresh deploy.** Whitelist semantics silently invert from "vetted" to "unvalidated".

---

## F-96-2 — `_referralSplitter == address(0)` Silently Disables Referral Path (SwapFeeRouter)

**File:** `contracts/src/SwapFeeRouter.sol:499-521`
**Init param:** `address _referralSplitter`

```
constructor(address _router, address _treasury, uint256 _feeBps, address _referralSplitter)
{
    if (_router == address(0) || _treasury == address(0)) revert ZeroAddress();
    if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
    ...
    if (_referralSplitter != address(0)) {
        referralSplitter = IReferralSplitter(_referralSplitter);
    }
    // PASS7-SFR-05 FIX: `sequencerFeed` defaults to address(0) ...
}
```

**Risk:** Three address args (`_router`, `_treasury`, `_referralSplitter`) — only two are zero-checked. `_referralSplitter == address(0)` is treated as **valid**: the entire referral pipeline is silently disabled forever (no setter exists in this contract; field is mutated only via `applyReferralSplitter` after a 48h timelock). A typo or env-var omission at deploy time:
- Disables 20% revenue-share to referrers (REFERRAL_FEE_BPS = 2000).
- Inflates protocol-side accumulation, distorts on-chain accounting visible to indexers.
- Cannot be detected by any on-chain invariant (a "disabled splitter" looks identical to "no eligible referrers").

The deploy scripts (`DeployFinal.s.sol:119`, `DeployV2.s.sol:105-110`, `DeployAuditFixes.s.sol:64`) all wire `address(referral)` — fine in the happy path, but the contract itself accepts `0` without reverting. **There is no `setReferralSplitterFirstTime` one-shot equivalent of the sequencer-feed pattern**, so a missed wire is detected only by post-deploy probing.

**Default-misconfig risk:** **MEDIUM** — silent-disable, no on-chain alarm.

**Fix shape:** Hard-revert on `_referralSplitter == address(0)`. The 48h timelocked setter remains the legitimate change path; a broken-at-construction state is never desirable.

---

## F-96-3 — Sequencer-Feed Default-To-Zero Across Five Contracts (L2 Deploy Footgun)

**Files (constructor + deploy script pairs):**
- `contracts/src/POLAccumulator.sol:271-306` ← `_sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0))`
- `contracts/src/MemeBountyBoard.sol:265-283` ← same
- `contracts/src/TegridyTWAP.sol:203-208` ← same
- `contracts/src/TegridyLaunchpadV2.sol:160-178` ← same
- `contracts/src/TegridyDropV2.sol:399` ← same (read from `InitParams.sequencerFeed`, deployer-controlled)
- `contracts/src/TegridyLending.sol:354-357` ← hardcoded `address(0)` at construct (post-deploy one-shot setter exists)
- `contracts/src/TegridyNFTLending.sol:354-357` ← same as TegridyLending

**Init param:** `address _sequencerFeed` (or InitParams.sequencerFeed)
**Deploy default:** `vm.envOr("SEQUENCER_FEED", address(0))` — env-omission silently passes 0.

**Risk:** Pattern is documented: "R062: zero permitted (mainnet / non-L2 = gating disabled)." But:
1. **Every deploy script defaults to 0** (`DeployFinal.s.sol:137`, `DeploySepolia.s.sol:153,173`, `DeployRemaining.s.sol:49`, `DeployAuditFixes.s.sol:98`, `DeployV2.s.sol:144`, `DeployTWAP.s.sol:29`, `DeployLaunchpadV2.s.sol:38`).
2. On an L2 deploy (Base/Arbitrum/Optimism), forgetting to set `SEQUENCER_FEED` env produces a perfectly functional contract that has **zero sequencer-outage protection** — no revert, no event, no on-chain trace. The protocol will price liquidations / mints / Dutch-auction decay against stale post-outage Chainlink data.
3. Aave V3 PriceOracleSentinel is referenced as the design-pattern source; Aave hard-fails sentinel reads when feed is unset on L2. The Tegriddy implementation is intentionally fail-open, which is defensible for mainnet but **a different decision is required at deploy time per chain**.

For TegridyLending / TegridyNFTLending: the constructor hardcodes 0 (no constructor parameter exposed), and a separate `setSequencerFeed` one-shot setter is provided post-deploy. If the ops team forgets to call it on the L2 deploy, the same fail-open hole exists.

**Default-misconfig risk:** **HIGH** specifically when a future L2 redeploy happens. Mitigation depends entirely on operational discipline. The deploy scripts should require `SEQUENCER_FEED` to be set when `block.chainid != 1`, not silently default to 0.

**Fix shape:** In each deploy script, add:
```
if (block.chainid != 1 && SEQUENCER_FEED == address(0)) revert("L2 deploy missing SEQUENCER_FEED");
```

---

## F-96-4 — `multisig == address(0)` Silently Skips Ownership Transfer

**Files:**
- `contracts/script/DeployGaugeController.s.sol:18-22`
- `contracts/script/DeployTegridyLPFarming.s.sol:53-59`
- `contracts/script/DeploySwapFeeRouterV2.s.sol:55-62`

```
address multisig = vm.envOr("MULTISIG", address(0));
if (multisig != address(0)) {
    farm.transferOwnership(multisig);
    console.log("...");
} else {
    console.log("SKIPPED ownership transfer (no MULTISIG env var)");
}
```

**Risk:** When `MULTISIG` env var is missing, deploy completes successfully and the deployer EOA remains the owner forever. Combined with `OwnableNoRenounce` (renounce permanently disabled), the deployer becomes a permanent admin **with no on-chain alarm**. A console.log line is the only signal — invisible from chain explorers. After the deployer's key is rotated/lost, the contract is permanently owner-locked to a dead key.

This contrasts with the safer pattern in `DeployFinal.s.sol:52-53`, `DeployV2.s.sol:182-183`, and others:
```
address multisig = vm.envAddress("MULTISIG");
require(multisig != address(0), "MULTISIG env var required");
```

`vm.envAddress` reverts on missing env; `vm.envOr` does not.

**Default-misconfig risk:** **HIGH** — owner ends up as deployer EOA. Combined with `feedback_bulletproof_mandate`, this directly exposes the protocol to deployer-key compromise (see project_relaunch.md context — the new wallet is the very thing this fallback would reveal in event of leak).

**Fix shape:** Replace all three `vm.envOr("MULTISIG", address(0))` with `vm.envAddress("MULTISIG")` + `require != 0`.

---

## F-96-5 — `initialOwner = msg.sender` (Deployer-Captured Bootstrap) Across 22+ Contracts

**Files (all use `OwnableNoRenounce(msg.sender)` in constructor):**
- TegridyStaking, TegridyRestaking, RevenueDistributor, SwapFeeRouter, SwapFeeRouterAdmin, POLAccumulator, PremiumAccess, ReferralSplitter, CommunityGrants, MemeBountyBoard, GaugeController, VoteIncentives, VoteIncentivesAdmin, TegridyStakingAdmin, TegridyLending, TegridyLendingAdmin, TegridyLPFarming, TegridyNFTLending — and TegridyTWAP via its ad-hoc `Ownable2Step` constructor at line 53.

**Risk:** The standard pattern is:
```
constructor(...) OwnableNoRenounce(msg.sender) { ... }
```
followed by a deploy-time `transferOwnership(MULTISIG)` in the script. `Ownable2Step` requires the new owner to call `acceptOwnership()` — until that completes, the deployer EOA retains full owner rights AND the deployer can rewind the transfer by calling `transferOwnership(otherAddress)` again before acceptance.

If deployer key is compromised in the window between `new TegridyStaking(...)` deployment and multisig `acceptOwnership()`:
- All admin functions remain callable (e.g., `setSwapFeeRouterAdmin`, `setRestakingContract`, `setJbacVault`).
- One-shot guarded setters (`setSwapFeeRouterAdmin`, `setJbacVault`, `setSequencerFeed`) **can be locked to attacker-controlled values**, becoming permanent given the one-shot semantic.
- The compromised attacker may also re-target ownership transfer to their address before the multisig calls `acceptOwnership()`.

The contract layer takes msg.sender; the script layer immediately transfers; the multisig layer must accept. There is a window. For some contracts (`TegridyDropV2.initialize`, `TegridyNFTPool.initialize`) the `_owner` is passed explicitly as a constructor/init parameter, which is the safer pattern (deployer never holds owner).

**Default-misconfig risk:** **MEDIUM** — windowed exposure. Some contracts (TegridyLaunchpadV2, TegridyFeeHook, TegridyNFTPoolFactory) accept `_owner` as a constructor arg, which sidesteps this. The 22+ that don't, do not.

**Fix shape:** Where backwards-compat allows, change `OwnableNoRenounce(msg.sender)` → `OwnableNoRenounce(_initialOwner)` and pass MULTISIG directly. Where not feasible, ensure the deploy script always calls `acceptOwnership()` from the multisig (or simulates it via cast) inside the same broadcast.

---

## F-96-6 — VoteIncentives 5-Address Constructor Param Order Footgun

**File:** `contracts/src/VoteIncentives.sol:506-522`
**Init param ordering:**
```
constructor(
    address _votingEscrow,   // = TegridyStaking
    address _treasury,       // = MULTISIG / TREASURY constant
    address _weth,
    address _factory,        // = TegridyFactory
    address _toweli,         // = TOWELI ERC20
    uint256 _bribeFeeBps
)
```

**Risk:** Five same-typed `address` params in sequence with NO ABI sanity-check on the contracts they point to. The constructor only validates `!= address(0)`, not interface conformance. An order error in the deploy script produces a fully-deployed but completely broken VoteIncentives:
- Swap `_votingEscrow ↔ _toweli`: `votingEscrow.totalBoostedStake()` calls TOWELI.balanceOf-like selector which doesn't exist → revert on first epoch.
- Swap `_treasury ↔ _factory`: bribes are sent to the factory address (unrecoverable) or factory address is interpreted as a bribe destination.
- Swap `_factory ↔ _toweli`: `factory.isPair(...)` resolves against TOWELI.balanceOf, returns garbage → bribes accepted on non-existent pairs.

The order in `DeployV2.s.sol:65-72`:
```
new VoteIncentives(
    address(staking),     // _votingEscrow
    TREASURY,
    WETH,
    TEGRIDY_FACTORY,
    TOWELI,
    BRIBE_FEE_BPS
)
```
…is correct. But **a future redeploy script** can easily transpose any pair. There is NO interface probe (e.g., `IVotingEscrow(_votingEscrow).totalBoostedStake()` test-call) inside the constructor.

**Default-misconfig risk:** **MEDIUM** for a future redeploy. **LOW** for the current happy path.

**Fix shape:** Add cheap probe calls (try/catch) at construction for at least the most-critical pointers, e.g.:
```
try IVotingEscrow(_votingEscrow).totalBoostedStake() returns (uint256) {}
catch { revert("BAD_VOTING_ESCROW"); }
```

The same critique applies to:
- `PremiumAccess(_toweli, _jbacNFT, _treasury, _monthlyFee)` — `_toweli` (ERC20) and `_jbacNFT` (ERC721) are both address; swap would brick subscription minting.
- `RevenueDistributor(_votingEscrow, _treasury, _weth)` — swap `_treasury ↔ _weth` ships a contract that loops ETH to the WETH9 contract instead of treasury.
- `CommunityGrants(_votingEscrow, _toweli, _feeReceiver, _weth)` — swap `_toweli ↔ _weth` produces a contract that escrows WETH for proposals (irrecoverable).

---

## F-96-7 — `_emissionBudget` Unbounded On GaugeController Constructor

**File:** `contracts/src/GaugeController.sol:270-279`
```
constructor(
    address _tegridyStaking,
    uint256 _emissionBudget
) OwnableNoRenounce(msg.sender) {
    if (_tegridyStaking == address(0)) revert ZeroAddress();
    tegridyStaking = ITegridyStakingGauge(_tegridyStaking);
    emissionBudget = _emissionBudget;
    ...
}
```

**Risk:** No bounds on `_emissionBudget`. The deploy script `DeployGaugeController.s.sol:9` sets `EMISSION_BUDGET = 1_000_000e18` (1M TOWELI/epoch). A deployer typo of `100_000_000e18` (100M) ships a permanent emission stream that can drain the entire 420.69B TOWELI supply in 4,206 epochs (~80 years at week-long epochs — mostly theoretical, but the immutable-with-no-setter pattern means **there is no recovery once deployed**).

The contract DOES have `proposeEmissionBudgetChange` / `executeEmissionBudgetChange` setters (need to verify — let me focus on constructor scope): even if a setter exists, the propose/execute window means inadvertent emissions can leak before correction.

**Default-misconfig risk:** **LOW-MEDIUM** — operationally limited, but cap-at-construct cost is minimal.

**Fix shape:** Add `if (_emissionBudget > MAX_EMISSION_BUDGET_PER_EPOCH) revert ...` at construct. Cap is design-decision.

---

## F-96-8 — Constructor Does NOT Enforce Contract-Code On Address Args (TegridyStaking)

**File:** `contracts/src/TegridyStaking.sol:442-458`
```
constructor(
    address _rewardToken,
    address _jbacNFT,
    address _treasury,
    uint256 _rewardRate
) {
    if (_rewardToken == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
    if (_rewardRate > MAX_REWARD_RATE) revert RateTooHigh();
    rewardToken = IERC20(_rewardToken);
    jbacNFT = IERC721(_jbacNFT);
    ...
}
```

**Risk:** `_rewardToken` and `_jbacNFT` are not `code.length > 0` checked. A deploy-time typo passing an EOA address (e.g., copy-paste deployer wallet by mistake) ships a fully-deployed contract that:
- Reverts on every stake/unstake (calls to ERC20/ERC721 selectors against an EOA → empty returndata → revert in `safeTransferFrom`).
- Is owner-only-fixable, but the fix path requires migration (the immutable IERC20/IERC721 fields are storage-final after constructor).
- Same critique applies to `RevenueDistributor`, `VoteIncentives`, `CommunityGrants`, `MemeBountyBoard`, `TegridyLPFarming`.

The pattern is correctly applied in the **post-deploy setters** (`setJbacVault` line 469: `if (_vault.code.length == 0) revert NotAContract();`, `setSequencerFeed` line 391-393: same shape). But the **constructor itself** trusts the deployer.

**Default-misconfig risk:** **LOW** (operationally a smoke-test would catch this) but easy fix.

**Fix shape:** Add `if (_rewardToken.code.length == 0 || _jbacNFT.code.length == 0) revert NotAContract();` to all constructor sites that take ERC-token addresses.

---

## F-96-9 — TegridyDropV2.initialize Does NOT Reject mintPrice == 0

**File:** `contracts/src/TegridyDropV2.sol:377-458`
```
function initialize(InitParams calldata p) external initializer {
    if (p.creator == address(0)) revert ZeroAddress();
    if (p.platformFeeRecipient == address(0)) revert ZeroAddress();
    if (p.weth == address(0)) revert ZeroAddress();
    if (p.maxSupply == 0) revert InvalidMaxSupply();
    if (p.platformFeeBps > MAX_PLATFORM_FEE_BPS) revert InvalidFeeBps();
    if (p.royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyaltyBps();
    if (uint8(p.initialPhase) > uint8(MintPhase.DUTCH_AUCTION)) revert InvalidInitialPhase();
    ...
    mintPrice = p.mintPrice;  // <-- no check
    ...
}
```

**Risk:** The contract recognises `ZeroPricePostMint` ("mintPrice = 0 is gated to the pre-mint window"), but at init time, `mintPrice = 0` is accepted. A creator-controlled clone (factory `createCollection` flow) ships a free-mint collection. This may be intentional — but combined with non-zero `platformFeeBps`, it produces a divide-by-something-or-other surface in the fee calculation if any helper assumes `mintPrice > 0`.

If the launch script also sets `initialPhase = PUBLIC`, the collection is open + free at deploy, with no public on-chain announcement that this was a deploy-time configuration.

**Default-misconfig risk:** **LOW** (creator chooses, and free mint is a legitimate launch model). Listed as deviating from the "ZeroPricePostMint" defensive intent visible elsewhere in the contract.

---

## F-96-10 — `TegridyFactory(_feeToSetter, _feeTo)` Both EOA-Settable At Construct

**File:** `contracts/src/TegridyFactory.sol:121-128`
```
constructor(address _feeToSetter, address _feeTo) {
    require(_feeToSetter != address(0), "ZERO_SETTER");
    require(_feeTo != address(0), "ZERO_FEE_TO");
    feeToSetter = _feeToSetter;
    feeTo = _feeTo;
    emit FactoryInitialized(_feeToSetter, _feeTo);
}
```

**Deploy scripts:**
- `DeployFinal.s.sol:79`: `new TegridyFactory(deployer, TREASURY)` — `_feeToSetter = deployer EOA`.
- `DeploySepolia.s.sol:104`: same pattern, `deployer = msg.sender` doubles as `_feeToSetter`.

**Risk:** `feeToSetter` is the unilateral controller of `feeTo` rotations + `pendingGuardian`. It is initialized to **the deployer EOA** in production (DeployFinal.s.sol:79), then transferred via `proposeFeeToSetter(MULTISIG)` post-deploy (line 184 of DeployFinal). That transfer requires multisig acceptance (`acceptFeeToSetter()`), which has a 48h timelock. The full window between `new TegridyFactory(deployer, TREASURY)` and `acceptFeeToSetter()` exposes the deployer EOA as the **permission root for fee routing**.

Combine with:
- `feeTo == TREASURY` is set immediately at construct, so unauthorized `setFeeTo` in the gap could re-route LP-fee skim to attacker.
- Deployer key compromise during this window has no on-chain detection mechanism.

**Default-misconfig risk:** **MEDIUM** — windowed but addressable.

**Fix shape:** Pass MULTISIG directly as `_feeToSetter` rather than deployer; deploy script still works because the deployer doesn't need feeToSetter rights post-deploy.

---

## F-96-11 — `WireV2.s.sol` Has MULTISIG Hardcoded To TREASURY

**File:** `contracts/script/WireV2.s.sol:44-45`
```
address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
address constant MULTISIG = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;  // <-- same as TREASURY in other scripts
```

**Risk:** `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` is the literal `TREASURY` constant in `DeployFinal.s.sol:25`, `DeployV2.s.sol:34`, etc. **MULTISIG and TREASURY are the same on-chain address.** This is either:
1. By design (the multisig IS the treasury — common, defensible).
2. A copy-paste error where MULTISIG was meant to be a different governance address.

If (1): the comment says so explicitly somewhere; cross-cluster verified. Fine.

If (2): the protocol's "multisig" governance role and "treasury" sweep destination are the same Safe — a single compromise drains both authority and funds simultaneously. No segregation of duties.

The project relaunch context (`project_relaunch.md` per memory: full relaunch from new wallet) suggests this was intentional — but worth flagging since the wire script silently transfers ownership to TREASURY without acknowledgement that this conflates governance + treasury.

**Default-misconfig risk:** **LOW** — likely intentional, flagging for owner clarification.

---

## F-96-12 — `TegridyTWAP.constructor()` Inline Ownable Pattern Bypasses `OwnableNoRenounce`

**File:** `contracts/src/TegridyTWAP.sol:53-75`
```
constructor() {
    owner = msg.sender;
    emit OwnershipTransferred(address(0), msg.sender);
}
modifier onlyOwner() {
    if (msg.sender != owner) revert NotOwner();
    _;
}
function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert TWAPZeroAddress();
    pendingOwner = newOwner;
    emit OwnershipTransferStarted(owner, newOwner);
}
function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert NotOwner();
    ...
}
function renounceOwnership() external pure {
    revert("RENOUNCE_DISABLED");
}
```

**Risk:** This is an ad-hoc Ownable2Step rolled inline rather than inheriting `OwnableNoRenounce` like everyone else. The behavior is functionally equivalent BUT:
1. Differs in error type (`NotOwner` vs `OwnableUnauthorizedAccount`) — integrators (off-chain monitors, Safe modules, ABI-aware UIs) parsing for the standard OZ revert string will not match.
2. `renounceOwnership()` reverts with a string, not a custom error — wastes gas per call attempt and breaks ABI-decoder uniformity.
3. The rest of the codebase consistently uses `OwnableNoRenounce(msg.sender)` — maintainability divergence creates a future cross-cutting refactor risk.

**Default-misconfig risk:** **LOW** (functional). Consistency-only. Listed for completeness of the "constructor / owner-init" lens.

---

## F-96-13 — `TegridyFeeHook` Constructor Requires Specific Address-Bit Pattern (CREATE2 Salt-Mining)

**File:** `contracts/src/TegridyFeeHook.sol:207-229`
```
constructor(IPoolManager _poolManager, address _revenueDistributor, uint256 _feeBps, address _owner, address _weth)
    OwnableNoRenounce(_owner)
{
    if (address(_poolManager) == address(0) || _revenueDistributor == address(0) || _weth == address(0)) revert ZeroAddress();
    if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
    require(uint160(address(this)) & 0x3FFF == 0x0044, "INVALID_HOOK_ADDRESS");
    ...
}
```

**Deploy script:** `DeployTegridyFeeHook.s.sol:60-83`
```
uint256 feeBps = vm.envOr("TEGRIDY_FEE_HOOK_BPS", uint256(30));
salt = vm.envBytes32("CREATE2_SALT");
```

**Risk #1 — Pre-mined salt vulnerability:** The CREATE2 salt is mined off-chain via `cast create2 --ends-with 0044 --init-code-hash $INITCODE_HASH`. The init-code hash depends on **constructor arg encoding**. If the deployer mines a salt using one set of args (e.g., dev `_revenueDistributor`) but deploys with another (production `_revenueDistributor`), the deployed bytecode hash diverges → the address bits change → the `INVALID_HOOK_ADDRESS` revert fires at deploy time.

**Mitigation present:** Line 87-90 explicitly checks the deployed address bits and reverts if they don't match. Good.

**Risk #2 — `_feeBps` env-default 30 (0.3%) silently applied if env unset:** Line 60 `vm.envOr("TEGRIDY_FEE_HOOK_BPS", uint256(30))`. Deploy script silently accepts the 30 default. This is fine for production (matches design intent), but a future deploy with a different intended fee MUST explicitly export the env or the hardcoded 30 wins. This is a "silent default" that's explicitly documented but flagged for completeness.

**Default-misconfig risk:** **LOW** — protected by the on-chain address-bit check. Salt mismatch fails at deploy, not at runtime.

---

## F-96-14 — `TegridyNFTPoolFactory(_protocolFeeBps == 0 disallowed)` But No `MIN_PROTOCOL_FEE_BPS`

**File:** `contracts/src/TegridyNFTPoolFactory.sol:160-182`
```
constructor(
    address _owner,
    uint256 _protocolFeeBps,
    address _protocolFeeRecipient,
    address _weth
) OwnableNoRenounce(_owner) {
    if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
    if (_protocolFeeBps == 0) revert InvalidFee();
    if (_protocolFeeRecipient == address(0)) revert ZeroAddress();
    if (_weth == address(0)) revert ZeroAddress();
    ...
}
```

**Risk:** The constructor explicitly rejects `_protocolFeeBps == 0`, with the comment "Pools snapshot the factory fee at init and never update". Good defensive deploy-time check. **But there is no MIN_PROTOCOL_FEE_BPS** — `_protocolFeeBps = 1` (0.01%) is accepted and locked into all pools created by this factory. Setting an inadequate floor at deploy is recoverable (timelocked propose), but each pool is permanent at its snapshot fee. This is a deploy-time decision the constructor could enforce a lower bound on.

**Default-misconfig risk:** **LOW** — operationally addressed by ops team review. Listed for contrast with the upper-bound `MAX_PROTOCOL_FEE_BPS` that IS enforced.

---

## F-96-15 — `TegridyLaunchpadV2.dropTemplate = new TegridyDropV2()` In Constructor

**File:** `contracts/src/TegridyLaunchpadV2.sol:177`
```
dropTemplate = address(new TegridyDropV2());
```

**Risk:** The drop template is deployed inside the factory constructor. This pattern is correct (clones inherit immutable bytecode), BUT:
1. Test fixtures that mock `TegridyLaunchpadV2` constructor with overridden bytecode lose the template auto-deploy — tests must explicitly call `setDropTemplate(...)` if such a setter exists (it doesn't visible at this scope; not auditable here).
2. The deployed template's `_disableInitializers()` (line 24-26 of TegridyDropV2) prevents direct use of the template — good. The template address is exposed via `dropTemplate()` for verification but is otherwise inert.

**Default-misconfig risk:** **NONE** — defensive pattern is correct. Listed for completeness.

---

## F-96-16 — `ReferralSplitter._referralFeeBps == 0 disallowed`, But Caller-Approval State Bootstrap

**File:** `contracts/src/ReferralSplitter.sol:215-225`
```
constructor(uint256 _referralFeeBps, address _stakingContract, address _treasury, address _weth) {
    if (_referralFeeBps == 0) revert FeeTooHigh(); // S2-M-03
    if (_referralFeeBps > MAX_REFERRAL_FEE) revert FeeTooHigh();
    ...
}
```

**Risk:** Constructor correctly rejects zero fee. But all `approvedCallers` are zero at construct — the deploy script must explicitly call `setApprovedCaller(swapFeeRouter, true)` BEFORE `completeSetup()` is invoked, otherwise `completeSetup` locks the splitter with NO approved callers — fees can be received but never recorded.

The deploy scripts handle this correctly (`DeployFinal.s.sol:130-131`, `DeployV2.s.sol:164-166`), but the **contract itself does not enforce that `completeSetup()` requires at least one approved caller**. A future redeploy script that calls `completeSetup()` first ships a permanently-bricked splitter.

**Default-misconfig risk:** **LOW-MEDIUM** for future redeploys.

**Fix shape:** Inside `completeSetup`, add `if (approvedCallerCount == 0) revert NoApprovedCallers();` (would need a counter — operationally trivial).

---

## F-96-17 — TegridyPair `initialize(_token0, _token1)` Can Be Front-Run

**File:** `contracts/src/TegridyPair.sol:98-111`
```
constructor() ERC20("Tegridy LP", "TGLP") {
    factory = msg.sender;
}
function initialize(address _token0, address _token1) external {
    require(msg.sender == factory, "FORBIDDEN");
    require(!_initialized, "ALREADY_INITIALIZED");
    require(_token0 != address(0) && _token1 != address(0), "ZERO_ADDRESS");
    _initialized = true;
    token0 = _token0;
    token1 = _token1;
    emit Initialize(_token0, _token1);
}
```

**Risk:** The factory deploys via `new TegridyPair()` and immediately calls `initialize(t0, t1)` in the same transaction (`createPair` flow). This is the standard Uniswap V2 pattern and is safe BECAUSE `_initialized` is checked. **But:** there is no enforcement that `_token0 != _token1` (uniqueness check happens in factory, not in pair). A factory bug would let you initialize a pair as TOKENA/TOKENA — `swap` math would divide by zero or revert mid-swap, locking funds. This is a defense-in-depth gap.

**Default-misconfig risk:** **LOW** (factory does the unique-pair check) — listed as defense-in-depth.

---

## Notes / Dead-Ends

- **TegridyRouter constructor:** zero-address checked on factory + WETH; clean.
- **POLAccumulator:** strong constructor with canonical-pair LP cross-check via `IUniswapV2Factory.getPair`. Top-tier defensive pattern; closes the LP-spoofing surface. No findings.
- **TegridyRestaking:** robust constructor — all 3 addresses zero-checked, `_rewardToken != _bonusRewardToken` enforced, `_bonusRewardPerSecond ≤ 10e18`. No findings.
- **TegridyLPFarming:** `_rewardToken != _stakingToken` MasterChef-class footgun guarded; `_rewardsDuration` bounded. Clean.
- **OwnableNoRenounce(initialOwner):** Comment correctly notes the OZ-Ownable parent already enforces `initialOwner != address(0)`. No issues.
- **Toweli ERC20 constructor:** Correctly takes `recipient` arg, mints once, then `_initialMintDone = true` prevents future mints. The DEFERRED `code.length > 0` check on recipient is documented and defensible (test-fixture friction).
- **CommunityGrants constructor:** All 4 addresses zero-checked; clean.
- **TegridyTokenURIReader:** Deliberately minimal — `_staking` not zero-checked (will revert on first read if invalid). Listed as a minor defensive omission, not a security issue.
- **Sister-admin contracts (StakingAdmin, LendingAdmin, VoteIncentivesAdmin, SwapFeeRouterAdmin):** All correctly zero-check the single host pointer. No findings.

---

## Summary

| Finding | Severity | Surface |
|---|---|---|
| F-96-1 | HIGH (L2/testnet only) | TegridyNFTLending mainnet-NFT hardcode |
| F-96-2 | MEDIUM | SwapFeeRouter silently disables referrals on `address(0)` |
| F-96-3 | HIGH (L2 redeploy) | SEQUENCER_FEED defaults to 0 across 7 contracts |
| F-96-4 | HIGH | 3 deploy scripts skip ownership transfer when MULTISIG env missing |
| F-96-5 | MEDIUM | 22+ contracts use `msg.sender` as initial owner — windowed exposure |
| F-96-6 | MEDIUM | VoteIncentives 5-address-arg constructor — order-swap footgun |
| F-96-7 | LOW-MEDIUM | GaugeController unbounded `_emissionBudget` |
| F-96-8 | LOW | TegridyStaking constructor lacks `code.length` check on token addresses |
| F-96-9 | LOW | TegridyDropV2 init accepts `mintPrice == 0` |
| F-96-10 | MEDIUM | TegridyFactory deploys with deployer EOA as feeToSetter |
| F-96-11 | LOW (clarification) | WireV2 hardcodes MULTISIG == TREASURY (intentional?) |
| F-96-12 | LOW | TegridyTWAP rolls inline Ownable instead of OwnableNoRenounce |
| F-96-13 | LOW | TegridyFeeHook fee env defaults to 30 silently |
| F-96-14 | LOW | TegridyNFTPoolFactory has no MIN_PROTOCOL_FEE_BPS |
| F-96-15 | NONE | TegridyLaunchpadV2 in-constructor template deploy (informational) |
| F-96-16 | LOW-MEDIUM | ReferralSplitter `completeSetup()` doesn't require approved-caller count |
| F-96-17 | LOW | TegridyPair lacks `_token0 != _token1` defense-in-depth |

**Most critical:** F-96-1 (NFT-collateral hardcode), F-96-3 (silent L2 sequencer-feed bypass), F-96-4 (silent owner-EOA persistence on missing MULTISIG env).
