// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./TegridyPair.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {TegridyFactoryLib} from "./lib/TegridyFactoryLib.sol";
// AUDIT FIX 2026-05-26 [H-08] — EnumerableSet tracks per-token TOKEN_BLOCK_CHANGE
// and per-pair PAIR_DISABLE_CHANGE pending proposals so acceptFeeToSetter can
// flush every queued proposal the OLD setter left behind on rotation.
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title TegridyFactory — Creates and manages AMM liquidity pools
/// @notice Fork of Uniswap V2 Factory. Creates TegridyPair pools for any token pair.
///
///         Features:
///         - Create pools for any ERC20 pair (PEPE/ETH, USDC/ETH, TOWELI/USDT, etc.)
///         - Protocol fee (0.05% of swap volume) sent to feeTo address
///         - Unlimited pools — add any pair anytime
///         - Each pool is a TegridyPair contract with its own LP token
contract TegridyFactory is TimelockAdmin {
    using EnumerableSet for EnumerableSet.AddressSet; // AUDIT FIX 2026-05-26 [H-08]

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_TO_CHANGE = keccak256("FEE_TO_CHANGE");
    bytes32 public constant TOKEN_BLOCK_CHANGE = keccak256("TOKEN_BLOCK_CHANGE");
    bytes32 public constant PAIR_DISABLE_CHANGE = keccak256("PAIR_DISABLE_CHANGE");
    /// @notice AUDIT R028 H-01 (HIGH): timelock for guardian rotation.
    ///         Initial set via setGuardian() remains instant (one-shot, only
    ///         while guardian == address(0)). Any subsequent rotation must
    ///         traverse propose → execute with the 48h delay below.
    /// @dev    Constants only — no storage. The associated state (`pendingGuardian`)
    ///         is appended at the end of the storage layout to preserve slot
    ///         positions for existing test cheats (R064 PaginationBounds slot 7).
    bytes32 public constant GUARDIAN_CHANGE = keccak256("GUARDIAN_CHANGE");
    uint256 public constant GUARDIAN_CHANGE_DELAY = 48 hours;

    address public feeTo;      // Address that receives protocol fees (treasury)
    address public feeToSetter; // Address allowed to change feeTo

    // AUDIT FIX #34: 2-step feeToSetter transfer to prevent accidental loss of admin control
    address public pendingFeeToSetter;

    /// @notice AUDIT NEW-A2 (HIGH): guardian role for INSTANT emergency pair disable.
    ///         The normal disable path is timelocked (48h) so governance can be audited.
    ///         But if a malicious token (e.g. an upgradeable ERC-20 that flips to FoT /
    ///         transfer-hook mode post-listing) is actively draining a pair, a 48h delay
    ///         is game-over. This lets a separately-signed guardian multisig circuit-break
    ///         instantly. Only disables — no re-enable shortcut. Re-enable still needs
    ///         the 48h timelock. Guardian is set by feeToSetter.
    address public guardian;

    // AUDIT FIX: Timelock for feeTo changes to prevent instant fee redirection
    uint256 public constant FEE_TO_CHANGE_DELAY = 48 hours;
    address public pendingFeeTo;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    /// @notice AUDIT R014 (oracle layer, Wave-014): O(1) authenticity lookup for any
    ///         address claiming to be a TegridyPair created by THIS factory. Used by
    ///         `TegridyTWAP.update()` to reject `update(forgedPair)` calls — a forged
    ///         pair could otherwise return arbitrary cumulative prices and poison the
    ///         oracle. `getPair[token0][token1]` was previously the only authenticity
    ///         signal, but it requires the caller to know token0/token1 a priori, which
    ///         a TWAP doesn't have. `isPair[pair]` lets the oracle authenticate by pair
    ///         address alone in a single SLOAD.
    mapping(address => bool) public isPair;

    /// @notice R064 (LOW): hard ceiling on the total number of pairs this
    ///         factory will create. The on-chain `allPairs` array is
    ///         push-only with no enumeration helper exposed; once it grows
    ///         large, off-chain consumers (subgraphs, indexers, multisig
    ///         dashboards) must page through `allPairs(i)` index reads, and
    ///         a malicious actor could cheaply spam `createPair` to balloon
    ///         the array, degrading every factory observer. 10000 sits well
    ///         above any realistic single-protocol legitimate volume; if the
    ///         ceiling is ever approached, a v2 factory can be deployed
    ///         without disturbing existing pairs.
    uint256 public constant MAX_PAIRS = 10000;
    error PairLimitReached();
    /// @notice AUDIT FIX F-30-1 / M-21 (MED): emitted when a propose-disable or
    ///         emergency-disable call targets an address that was never registered
    ///         as a pair by THIS factory. Closes the surface where a captured
    ///         feeToSetter / guardian could pollute `disabledPairs` with arbitrary
    ///         addresses (EOAs, other forks' pairs, attacker-deployed contracts).
    error NotAPair();
    /// @notice AUDIT FIX H-16 / F-94-02 (HIGH): emitted when `emergencyDisablePair`
    ///         is called more than `MAX_EMERGENCY_DISABLES_PER_DAY` times in the
    ///         current rolling UTC day. Caps a single-key compromise blast radius
    ///         from "DoS the entire AMM in one block" to "DoS at most 3 pairs per
    ///         day" — giving veTOWELI holders / off-chain monitors >24h to escalate
    ///         a guardian rotation via the 48h timelock.
    error EmergencyDisableRateLimited();
    /// @notice AUDIT FIX H-16 / F-94-02 (HIGH): per-day cap on
    ///         `emergencyDisablePair`. 3/day matches Compound's pause-guardian
    ///         discipline pattern — sufficient for a real incident (one
    ///         actively-exploited pair plus two fail-safe disables), well below
    ///         what a captured key needs to DoS the AMM.
    uint8 public constant MAX_EMERGENCY_DISABLES_PER_DAY = 3;

    mapping(address => bool) public blockedTokens;
    mapping(address => bool) public disabledPairs;
    mapping(address => bool) public pendingPairDisableValue;
    uint256 public constant PAIR_DISABLE_DELAY = 48 hours;

    // Per-token and per-pair pending values for keyed timelocks
    mapping(address => bool) public pendingTokenBlockValue;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);
    event FeeToUpdated(address indexed oldFeeTo, address indexed newFeeTo);
    event FactoryInitialized(address indexed feeToSetter, address indexed feeTo);
    event TokenBlocked(address indexed token, bool blocked);
    event PairDisableProposed(address indexed pair, bool disabled, uint256 executeAfter);
    event PairDisableExecuted(address indexed pair, bool disabled);
    /// @notice AUDIT R016 L-1 (LOW): emitted when `cancelPairDisabled` voids a pending
    ///         pair disable/enable proposal. Sister cancel functions
    ///         (`cancelTokenBlocked`, `cancelFeeToChange`, etc.) all emit cancellation
    ///         events; this one was silent, leaving off-chain indexers without a clean
    ///         signal that a previously-proposed pair-disable was cancelled.
    event PairDisableCancelled(address indexed pair);
    event FeeToSetterProposed(address indexed current, address indexed proposed, uint256 executeAfter);
    event FeeToSetterAccepted(address indexed oldSetter, address indexed newSetter);
    /// @notice AUDIT FIX F-30-2 / F-75-4 / M-22 (MED): inverted timelock asymmetry —
    ///         setter rotation is now SHORTER (24h) than fee-direction change (48h),
    ///         so a legitimate setter rotation can complete before a compromised
    ///         setter's pending FEE_TO_CHANGE becomes executable. Previously both
    ///         were 48h, which structurally favoured the attacker (they queued first,
    ///         legitimate rotation could not catch up before execute window opened).
    uint256 public constant FEE_TO_SETTER_DELAY = 24 hours;
    uint256 public feeToSetterChangeTime;
    event FeeToChangeProposed(address indexed current, address indexed proposed, uint256 executeAfter);
    event FeeToChangeCancelled(address indexed cancelled);

    // Legacy error declarations (kept for test compat — TimelockAdmin errors are thrown instead)
    // None needed — Factory used require() strings, not custom errors

    event TokenBlockProposed(address indexed token, bool blocked, uint256 executeAfter);
    event TokenBlockCancelled(address indexed token);
    event FeeToSetterProposalCancelled(address indexed cancelledSetter);

    // Legacy constant kept for test compatibility
    uint256 public constant MAX_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant MAX_SETTER_PROPOSAL_VALIDITY = 7 days;
    uint256 public constant TOKEN_BLOCK_DELAY = 24 hours;

    // [M1 FIX] Max entries flushed per flushStaleProposals call. Bounds the per-tx
    // gas cost so a griefing setter who queued many proposals cannot OOG the flush.
    // 50 entries × ~5 000 gas each ≈ 250 000 gas — comfortably within any block limit.
    uint256 public constant MAX_FLUSH_BATCH = 50;

    // ─── AUDIT R028 H-01 — appended to preserve original storage layout ───
    /// @dev Pending value for the timelocked guardian rotation flow. Placed at
    ///      the end of storage so existing test cheats and any external slot-
    ///      based readers continue to work against the original layout.
    address public pendingGuardian;

    // ─── AUDIT FIX H-16 / F-94-02 — emergency-disable per-day rate limiter ─
    /// @notice Number of `emergencyDisablePair` calls that have landed in the
    ///         current UTC day (`block.timestamp / 1 days`). Reset to 0 the
    ///         first time a new day's call comes in. Capped at
    ///         `MAX_EMERGENCY_DISABLES_PER_DAY` (3).
    /// @dev    Packed alongside `lastDisableDay` in a single storage slot.
    uint8 public emergencyDisablesToday;
    /// @notice The UTC day index (`block.timestamp / 1 days`) when
    ///         `emergencyDisablesToday` was last reset. Used to detect day
    ///         rollover before incrementing the counter.
    uint64 public lastDisableDay;

    // ─── AUDIT FIX 2026-05-26 [H-08] — pending-proposal enumeration ─────
    /// @notice Set of tokens with a currently-pending TOKEN_BLOCK_CHANGE proposal.
    ///         Maintained by `proposeTokenBlocked` (add) and
    ///         `executeTokenBlocked` / `cancelTokenBlocked` (remove).
    ///         [M1 FIX]: drained via flushStaleProposals() after acceptFeeToSetter
    ///         (not inside it — unbounded iteration caused OOG on setter rotation).
    /// @dev    Appended at the end of storage to preserve the existing slot layout.
    EnumerableSet.AddressSet private _pendingTokenBlocks;
    /// @notice Set of pairs with a currently-pending PAIR_DISABLE_CHANGE proposal.
    ///         Maintained by `proposePairDisabled` (add) and
    ///         `executePairDisabled` / `cancelPairDisabled` / `emergencyDisablePair`
    ///         (remove). [M1 FIX]: drained via flushStaleProposals() after acceptFeeToSetter.
    EnumerableSet.AddressSet private _pendingPairDisables;

    /// @param _feeToSetter The administrative key (multisig recommended) that controls
    ///                     fee redirection and pair-disable timelocks.
    /// @param _feeTo       The address that will receive protocol fees (LP-token mint
    ///                     destination on harvest).
    /// @param _guardian    AUDIT FIX F-30-9 (LOW): initial guardian (instant-disable
    ///                     emergency role) — must be non-zero. Pre-fix the contract
    ///                     allowed deploying with `guardian == address(0)` and patching
    ///                     it via the one-shot `setGuardian()` call, opening a
    ///                     deploy-window where a compromised feeToSetter could install
    ///                     a hostile guardian without timelock review. Post-fix the
    ///                     guardian is bound at deploy time alongside feeToSetter, and
    ///                     all subsequent rotations traverse `proposeGuardianChange()`
    ///                     with the 48h delay. Pass the deployer EOA here for the
    ///                     bootstrap; rotate to a multisig immediately via timelock.
    constructor(address _feeToSetter, address _feeTo, address _guardian) {
        // AUDIT FIX v2: Zero-address checks prevent permanent lockout of fee configuration
        require(_feeToSetter != address(0), "ZERO_SETTER");
        require(_feeTo != address(0), "ZERO_FEE_TO");
        // AUDIT FIX F-30-9 (LOW): non-zero guardian at deploy closes the
        // initial-setup race (compromised setter → instant guardian replacement
        // without 48h review).
        require(_guardian != address(0), "ZERO_GUARDIAN");
        feeToSetter = _feeToSetter;
        feeTo = _feeTo;
        guardian = _guardian;
        emit FactoryInitialized(_feeToSetter, _feeTo);
        emit GuardianSet(address(0), _guardian);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice R064 (LOW): paginated read of `allPairs` for off-chain
    ///         iteration. Returns `allPairs[start .. start+count)` clamped
    ///         to the array length. Off-chain consumers (subgraphs,
    ///         indexers) should prefer this over calling `allPairs(i)` in a
    ///         loop because it batches the bound check into a single
    ///         `eth_call`.
    /// @param start Starting index (inclusive)
    /// @param count Maximum number of entries to return; the result may be
    ///              shorter if `start + count > allPairs.length`.
    /// @return page Slice of `allPairs` covering the requested window.
    function allPairsPaginated(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = allPairs.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        uint256 n = end - start;
        page = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            page[i] = allPairs[start + i];
        }
    }

    /// @notice Create a new trading pair. Anyone can call this.
    /// @dev WARNING: ERC-777 tokens and tokens with transfer callbacks are NOT supported.
    ///      Pairs created with such tokens may be vulnerable to cross-contract reentrancy.
    ///      The swap() function follows the Uniswap V2 pattern of transferring tokens out
    ///      before updating reserves. While nonReentrant prevents re-entering the same pair,
    ///      ERC-777 callbacks could re-enter the router or other pairs with stale state.
    ///      Only create pairs with standard ERC-20 tokens.
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        // R064 (LOW): enforce the MAX_PAIRS ceiling BEFORE doing any other
        // work, so spam-attempts after the cap are cheap reverts.
        if (allPairs.length >= MAX_PAIRS) revert PairLimitReached();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ZERO_ADDRESS");
        // AUDIT FIX: Verify both tokens are contracts (not EOAs)
        // AUDIT FIX (BATCH-L1 M16, mirrors M29 OwnableNoRenounce): also reject
        // EIP-7702-delegated EOAs (code.length == 23 indicates the canonical
        // 0xef0100‖addr delegation pointer, NOT a real ERC-20).
        uint256 t0len = token0.code.length;
        uint256 t1len = token1.code.length;
        require(t0len > 0 && t0len != 23 && t1len > 0 && t1len != 23, "NOT_CONTRACT");
        // A4-M-10: Reject ERC-777 tokens — they have transfer callbacks that enable
        // cross-contract reentrancy with stale reserves. Check for ERC-1820 registry
        // introspection (ERC-777 tokens register their tokensReceived hook via ERC-1820).
        // Also reject ERC-165 supportsInterface for ERC-777 token interface ID (0xe58e113c).
        _rejectERC777(token0);
        _rejectERC777(token1);
        require(getPair[token0][token1] == address(0), "PAIR_EXISTS");

        // Deploy new pair contract.
        // AUDIT FIX (BATCH-L4 M2, mirrors NFTPoolFactory + LaunchpadV2 M3):
        // include chainid + factory so cross-chain CREATE2 collisions and
        // pre-deployed-elsewhere squatting are structurally impossible.
        // NOTE: this changes the deterministic pair address. Existing v1
        // deployments compute salt as keccak(token0,token1); new deployments
        // produce different addresses. Acceptable for the Wave-0 relaunch
        // (no cross-version address compatibility required).
        bytes32 salt = keccak256(abi.encode(block.chainid, address(this), token0, token1));
        // EIP-170 split: the CREATE2 deploy (which embeds the ~11KB TegridyPair creationCode)
        // is relocated to TegridyFactoryLib.deployPair via delegatecall. The executor is
        // still this Factory, so the deterministic pair address and the pair's
        // `factory = msg.sender` are byte-identical to the prior in-line create2.
        pair = TegridyFactoryLib.deployPair(salt);

        // SLITHER 2026-05-18: nonReentrant on entrypoint; cross-fn view-only reads cannot enable theft
        // slither-disable-next-line reentrancy-no-eth
        TegridyPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // Populate reverse mapping
        // AUDIT R014: O(1) pair-authenticity registry consumed by TegridyTWAP.update()
        // to reject forged-pair sources that would otherwise poison the oracle.
        isPair[pair] = true;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    /// @notice DEPRECATED: Use proposeFeeToChange() + executeFeeToChange() instead.
    ///         AUDIT FIX: Instant feeTo change replaced with 48h timelocked pattern.
    function setFeeTo(address) external pure {
        revert("Use proposeFeeToChange()");
    }

    /// @notice AUDIT FIX: Propose a feeTo change (takes effect after 48h delay)
    function proposeFeeToChange(address _feeTo) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(_feeTo != address(0), "ZERO_ADDRESS");
        pendingFeeTo = _feeTo;
        _propose(FEE_TO_CHANGE, FEE_TO_CHANGE_DELAY);
        emit FeeToChangeProposed(feeTo, _feeTo, _executeAfter[FEE_TO_CHANGE]);
    }

    /// @notice AUDIT FIX: Execute a previously proposed feeTo change after the timelock
    function executeFeeToChange() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        _execute(FEE_TO_CHANGE);
        address oldFeeTo = feeTo;
        feeTo = pendingFeeTo;
        pendingFeeTo = address(0);
        emit FeeToUpdated(oldFeeTo, feeTo);
    }

    /// @notice Cancel a pending feeTo change proposal.
    /// @dev    AUDIT FIX F-30-2 / M-22 (MED): extended cancel authority to the
    ///         guardian role. Combined with the asymmetric timelock (24h setter
    ///         rotation vs 48h fee change), this gives the guardian a second-
    ///         layer veto over a captured-feeToSetter's fee redirection. The
    ///         guardian cannot itself REDIRECT fees (only feeToSetter can call
    ///         `proposeFeeToChange`), so this expansion of authority is bounded
    ///         to "abort hostile proposals", matching its existing emergency
    ///         circuit-breaker role. Pre-fix the only canceller was the same
    ///         feeToSetter that proposed — useless if the setter itself was
    ///         compromised.
    function cancelFeeToChange() external {
        require(msg.sender == feeToSetter || msg.sender == guardian, "FORBIDDEN");
        address cancelled = pendingFeeTo;
        _cancel(FEE_TO_CHANGE);
        pendingFeeTo = address(0);
        emit FeeToChangeCancelled(cancelled);
    }

    /// @notice Legacy view helper for test compatibility
    function feeToChangeTime() external view returns (uint256) {
        return _executeAfter[FEE_TO_CHANGE];
    }

    /// @notice DEPRECATED: Use proposeFeeToSetter() + acceptFeeToSetter() instead.
    ///         AUDIT FIX #34: Single-step transfer replaced with 2-step pattern.
    function setFeeToSetter(address) external pure {
        revert("Use proposeFeeToSetter()");
    }

    /// @notice AUDIT FIX #34: Propose a new feeToSetter (first step of 2-step transfer)
    /// @param _newSetter The address being proposed as the new feeToSetter
    function proposeFeeToSetter(address _newSetter) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(_newSetter != address(0), "ZERO_ADDRESS");
        require(_newSetter != feeToSetter, "SAME_SETTER");
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        require(feeToSetterChangeTime == 0, "CANCEL_EXISTING_FIRST");
        pendingFeeToSetter = _newSetter;
        feeToSetterChangeTime = block.timestamp + FEE_TO_SETTER_DELAY;
        emit FeeToSetterProposed(feeToSetter, _newSetter, feeToSetterChangeTime);
    }

    /// @notice AUDIT FIX: Accept the feeToSetter role after timelock (must be called by pending address)
    function acceptFeeToSetter() external {
        require(msg.sender == pendingFeeToSetter, "NOT_PENDING");
        require(block.timestamp >= feeToSetterChangeTime, "TIMELOCK_NOT_ELAPSED");
        require(block.timestamp <= feeToSetterChangeTime + MAX_SETTER_PROPOSAL_VALIDITY, "PROPOSAL_EXPIRED");
        address oldSetter = feeToSetter;
        feeToSetter = pendingFeeToSetter;
        pendingFeeToSetter = address(0);
        feeToSetterChangeTime = 0;
        // SECURITY FIX C6: Clear any pending feeTo change proposed by the old setter
        // Prevents old setter's queued malicious feeTo from executing after transition
        // AUDIT FIX: DEEP-LIB-M5 — replace direct-write `_executeAfter[KEY]=0`
        //   with `_forceCancel(KEY)` so the canonical `ProposalCancelled(KEY)`
        //   event fires alongside the supplemental `FeeToChangeCancelled` one.
        //   Pre-fix off-chain monitors subscribed to `ProposalCancelled` (the
        //   protocol-wide standard) silently missed this cancellation; the
        //   helper restores parity with every other timelock-cancel path.
        if (_executeAfter[FEE_TO_CHANGE] != 0) {
            address cancelledFeeTo = pendingFeeTo;
            pendingFeeTo = address(0);
            _forceCancel(FEE_TO_CHANGE); // emits ProposalCancelled(FEE_TO_CHANGE)
            emit FeeToChangeCancelled(cancelledFeeTo); // legacy supplemental event
        }
        // AUDIT FIX F-30-10 (INFO): also force-cancel any pending GUARDIAN_CHANGE
        // proposed by the OLD setter. Pre-fix the new setter inherited a 48h-pending
        // hostile guardian rotation that they had to remember to cancel manually.
        // Mirrors the FEE_TO_CHANGE cleanup above. Per-token TOKEN_BLOCK_CHANGE and
        // per-pair PAIR_DISABLE_CHANGE proposals are NOT enumerable on-chain (each
        // is keyed by a separate hash) — they remain the new setter's responsibility
        // to cancel one-by-one, but a captured setter who queued mass token-blocks
        // is still bounded by the 24h-48h delays which give the new setter ample
        // time to triage.
        if (_executeAfter[GUARDIAN_CHANGE] != 0) {
            address cancelledGuardian = pendingGuardian;
            pendingGuardian = address(0);
            _forceCancel(GUARDIAN_CHANGE); // emits ProposalCancelled(GUARDIAN_CHANGE)
            emit GuardianChangeCancelled(cancelledGuardian); // legacy supplemental event
        }

        // [M1 FIX] Per-token TOKEN_BLOCK_CHANGE and per-pair PAIR_DISABLE_CHANGE
        // proposals queued by the OLD setter are NOT flushed here.
        // Pre-fix, unbounded loops caused acceptFeeToSetter to OOG when a
        // griefing setter queued many proposals, permanently bricking rotation.
        // Post-fix: the new setter calls flushStaleProposals(tokenCount, pairCount)
        // in up to MAX_FLUSH_BATCH-sized batches AFTER accepting. The old setter's
        // proposals cannot be executed by anyone other than the current feeToSetter
        // (see executeTokenBlocked / executePairDisabled require guards), so the new
        // setter will not accidentally trigger hostile proposals while draining the queues.
        // Pending proposals expire naturally after PROPOSAL_VALIDITY (7 days) regardless.

        emit FeeToSetterAccepted(oldSetter, feeToSetter);
    }

    /// @notice AUDIT FIX: Cancel a pending feeToSetter proposal.
    ///         Consistent with cancelFeeToChange() pattern.
    /// @dev    AUDIT FIX 2026-05-26 [L-24] — the legacy FeeToSetterProposalCancelled
    ///         event is the CANONICAL cancellation signal for this key. It does NOT
    ///         use the TimelockAdmin._cancel(KEY) pattern (and so does NOT emit
    ///         ProposalCancelled) because this rotation runs on its own pre-TimelockAdmin
    ///         storage slot (pendingFeeToSetter + feeToSetterChangeTime) rather than
    ///         through _executeAfter. Off-chain indexers must subscribe to
    ///         FeeToSetterProposalCancelled (NOT ProposalCancelled) for this flow.
    function cancelFeeToSetterProposal() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(pendingFeeToSetter != address(0), "NO_PENDING_PROPOSAL");
        address cancelled = pendingFeeToSetter;
        pendingFeeToSetter = address(0);
        feeToSetterChangeTime = 0;
        emit FeeToSetterProposalCancelled(cancelled);
    }

    /// @notice [M1 FIX] Paginated flush of stale per-token and per-pair proposals.
    ///         MUST be called by the new feeToSetter after acceptFeeToSetter() until
    ///         both sets are empty. Each call drains at most `tokenCount` token-block
    ///         proposals and `pairCount` pair-disable proposals.
    ///         Calling with tokenCount=0 and pairCount=0 is a no-op.
    ///         Sets are empty when pendingTokenBlockCount() / pendingPairDisableCount() == 0.
    ///         Old setter's proposals expire automatically after 7 days (PROPOSAL_VALIDITY)
    ///         even if flush is never called — the flush just provides an explicit
    ///         canonical path with on-chain events.
    /// @dev    Pattern: OZ Governor batched execute (page-by-page with per-call limit).
    function flushStaleProposals(uint256 tokenCount, uint256 pairCount) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        // Cap each leg to MAX_FLUSH_BATCH for predictable per-tx gas
        if (tokenCount > MAX_FLUSH_BATCH) tokenCount = MAX_FLUSH_BATCH;
        if (pairCount  > MAX_FLUSH_BATCH) pairCount  = MAX_FLUSH_BATCH;
        _flushTokenBlocks(tokenCount);
        _flushPairDisables(pairCount);
    }

    /// @notice Pending token-block proposal count (for off-chain flush scheduling).
    function pendingTokenBlockCount() external view returns (uint256) {
        return _pendingTokenBlocks.length();
    }

    /// @notice Pending pair-disable proposal count (for off-chain flush scheduling).
    function pendingPairDisableCount() external view returns (uint256) {
        return _pendingPairDisables.length();
    }

    function _flushTokenBlocks(uint256 count) internal {
        uint256 n = _pendingTokenBlocks.length();
        if (n < count) count = n;
        for (uint256 i = 0; i < count; i++) {
            // Always pop the last element (swap-and-pop safe iteration)
            address token = _pendingTokenBlocks.at(n - 1 - i);
            bytes32 tKey = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
            _forceCancel(tKey);
            delete pendingTokenBlockValue[token];
            // AUDIT 2026-05-30 [slither unused-return]: EnumerableSet.remove returns a
            // was-present bool; ignoring it is intentional and standard (the .at(...) above
            // guarantees the element exists). Matches repo convention at TWAP L611/941.
            // slither-disable-next-line unused-return
            _pendingTokenBlocks.remove(token);
            emit TokenBlockCancelled(token);
        }
    }

    function _flushPairDisables(uint256 count) internal {
        uint256 n = _pendingPairDisables.length();
        if (n < count) count = n;
        for (uint256 i = 0; i < count; i++) {
            address pair = _pendingPairDisables.at(n - 1 - i);
            bytes32 pKey = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
            _forceCancel(pKey);
            delete pendingPairDisableValue[pair];
            // AUDIT 2026-05-30 [slither unused-return]: same as _flushTokenBlocks above —
            // EnumerableSet.remove return ignored intentionally, .at(...) guarantees presence.
            // slither-disable-next-line unused-return
            _pendingPairDisables.remove(pair);
            emit PairDisableCancelled(pair);
        }
    }

    /// @dev A4-M-10: Best-effort ERC-777 detection. Checks ERC-165 supportsInterface for
    ///      the ERC-777 token interface ID. If the call reverts or returns false, the token
    ///      is assumed to be a standard ERC-20. This is not foolproof — a malicious token could
    ///      hide ERC-777 support by not implementing ERC-165, or a non-ERC-777 token could
    ///      register ERC-1820 hooks without being a full ERC-777 implementation.
    ///      AUDIT FIX M-35: Documented that this is best-effort and bypassable.
    ///      For maximum safety, maintain an off-chain allowlist of verified ERC-20 tokens.
    /// @dev AUDIT FIX D-AMM-INFO2: every external `staticcall` against the candidate
    ///      token (and against ERC-1820 with the candidate token as parameter) is
    ///      capped at 30_000 gas. Prevents a malicious token whose `supportsInterface`
    ///      / `granularity` / fallback consumes nearly all available gas from
    ///      OOG-griefing legitimate `createPair` callers.
    function _rejectERC777(address token) internal view {
        require(!blockedTokens[token], "TOKEN_BLOCKED");
        // EIP-170 split: the ERC-777 detection probing (ERC-165 supportsInterface /
        // granularity() / all three ERC-1820 hook interfaces, every staticcall 30k-gas-
        // capped) is relocated VERBATIM to TegridyFactoryLib.assertNotERC777 (delegatecall
        // lib). The `blockedTokens` gate stays here because it touches host storage; the
        // detection tail is storage-free + view-only, so it moves cleanly. Behaviour
        // byte-identical — same probes, same revert reason, same ordering.
        TegridyFactoryLib.assertNotERC777(token);
    }

    /// @notice AUDIT FIX L-29: Block or unblock a token (timelocked for consistency)
    /// @dev    AUDIT FIX 2026-05-26 [H-08]: track in _pendingTokenBlocks for flush on rotation.
    function proposeTokenBlocked(address token, bool blocked) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        pendingTokenBlockValue[token] = blocked;
        _propose(key, TOKEN_BLOCK_DELAY);
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.add returns a
        // was-added bool; idempotent add — surrounding _propose timelock and
        // pendingTokenBlockValue write make the in-set invariant deterministic.
        // Matches repo convention at _flushTokenBlocks L473.
        // slither-disable-next-line unused-return
        _pendingTokenBlocks.add(token); // AUDIT FIX 2026-05-26 [H-08]
        emit TokenBlockProposed(token, blocked, _executeAfter[key]);
    }

    function executeTokenBlocked(address token) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        _execute(key);
        blockedTokens[token] = pendingTokenBlockValue[token];
        delete pendingTokenBlockValue[token];
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored intentionally — proposeTokenBlocked added it; matching pair.
        // Same convention as _flushTokenBlocks L473.
        // slither-disable-next-line unused-return
        _pendingTokenBlocks.remove(token); // AUDIT FIX 2026-05-26 [H-08]
        emit TokenBlocked(token, blockedTokens[token]);
    }

    function cancelTokenBlocked(address token) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        _cancel(key);
        delete pendingTokenBlockValue[token];
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored — cancel path mirrors execute; presence implied by prior propose.
        // Same convention as _flushTokenBlocks L473.
        // slither-disable-next-line unused-return
        _pendingTokenBlocks.remove(token); // AUDIT FIX 2026-05-26 [H-08]
        emit TokenBlockCancelled(token);
    }

    /// @notice Legacy view helper for test compatibility
    function pendingTokenBlockTime(address token) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        return _executeAfter[key];
    }

    /// @notice AUDIT FIX F-30-5 (MED) — high-visibility token-block view for
    ///         frontends. Returns the pending token-block status and the
    ///         ready-after timestamp for `token`. Frontends should call this
    ///         before submitting a `createPair` or `mint` transaction
    ///         involving `token`, so users can see "this token is scheduled
    ///         to be blocked at T+24h" and abort the deposit. The pair's
    ///         `burn()` is intentionally NOT gated on `blockedTokens[]`
    ///         (LP escape hatch), so funds are never permanently locked, but
    ///         users had no on-chain warning surface pre-fix. The existing
    ///         `TokenBlockProposed` event already provides the high-visibility
    ///         log this fix mandates; this view exposes the same data via a
    ///         single eth_call so any frontend / monitoring tool can surface
    ///         a banner without subscribing to events.
    /// @param  token The token to query.
    /// @return blocked The proposed block value (`true` to add to blocklist,
    ///                 `false` to remove). When no proposal is pending this
    ///                 returns `false` and `readyAt == 0`.
    /// @return readyAt The timestamp after which `executeTokenBlocked(token)`
    ///                 becomes callable. Zero when no proposal is pending.
    function pendingTokenBlocks(address token) external view returns (bool blocked, uint256 readyAt) {
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        readyAt = _executeAfter[key];
        if (readyAt != 0) {
            blocked = pendingTokenBlockValue[token];
        }
    }

    /// @dev DEPRECATED: Use proposeTokenBlocked() + executeTokenBlocked()
    function setTokenBlocked(address, bool) external pure {
        revert("Use proposeTokenBlocked()");
    }

    /// @notice Propose disabling or re-enabling a pair (timelocked, owner-only)
    /// @dev    AUDIT FIX F-30-1 / M-21 (MED): require `isPair[pair]` so a captured
    ///         feeToSetter cannot pollute `disabledPairs` with arbitrary addresses
    ///         (EOAs, other forks' pairs, attacker-deployed contracts). Mirrors
    ///         the same gate in `emergencyDisablePair`. Off-chain consumers
    ///         (TWAP / VoteIncentives) defend in depth, but the registry should
    ///         not carry semantically-meaningless entries.
    /// @dev AUDIT FIX 2026-05-26 [H-08]: track in _pendingPairDisables for flush on rotation.
    function proposePairDisabled(address pair, bool disabled) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(pair != address(0), "ZERO_ADDRESS");
        if (!isPair[pair]) revert NotAPair();
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        pendingPairDisableValue[pair] = disabled;
        _propose(key, PAIR_DISABLE_DELAY);
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.add returns a
        // was-added bool; idempotent add — propose key uniqueness and the
        // pendingPairDisableValue write make in-set invariant deterministic.
        // Matches repo convention at _flushPairDisables L486.
        // slither-disable-next-line unused-return
        _pendingPairDisables.add(pair); // AUDIT FIX 2026-05-26 [H-08]
        emit PairDisableProposed(pair, disabled, _executeAfter[key]);
    }

    /// @notice Execute a previously proposed pair disable/enable after timelock
    function executePairDisabled(address pair) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        _execute(key);
        disabledPairs[pair] = pendingPairDisableValue[pair];
        delete pendingPairDisableValue[pair];
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored — proposePairDisabled added it; matching pair, presence implied.
        // Same convention as _flushPairDisables L486.
        // slither-disable-next-line unused-return
        _pendingPairDisables.remove(pair); // AUDIT FIX 2026-05-26 [H-08]
        emit PairDisableExecuted(pair, disabledPairs[pair]);
    }

    /// @notice Cancel a pending pair disable/enable proposal
    /// @dev AUDIT R016 L-1: emits `PairDisableCancelled(pair)` so off-chain
    ///      indexers see cancellations symmetrically with the sister
    ///      cancel functions (TokenBlock, FeeTo, Guardian).
    function cancelPairDisabled(address pair) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        _cancel(key);
        delete pendingPairDisableValue[pair];
        // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
        // ignored — cancel path mirrors execute; presence implied by prior propose.
        // Same convention as _flushPairDisables L486.
        // slither-disable-next-line unused-return
        _pendingPairDisables.remove(pair); // AUDIT FIX 2026-05-26 [H-08]
        emit PairDisableCancelled(pair);
    }

    /// @notice Legacy view helper for test compatibility
    function pendingPairDisableTime(address pair) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        return _executeAfter[key];
    }

    // ─── AUDIT NEW-A2: Emergency Pair Disable (guardian) ──────────────

    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);
    event GuardianChangeProposed(address indexed currentGuardian, address indexed proposedGuardian, uint256 executeAfter);
    event GuardianChangeExecuted(address indexed oldGuardian, address indexed newGuardian);
    event GuardianChangeCancelled(address indexed cancelled);
    event PairEmergencyDisabled(address indexed pair, address indexed by);

    /// @notice Set the guardian address (initial-only). Only feeToSetter may call,
    ///         and ONLY while guardian == address(0). Subsequent rotations must
    ///         use proposeGuardianChange() / executeGuardianChange() (48h timelock).
    /// @dev    AUDIT R028 H-01 (HIGH): Hardened from the prior unconditional setter,
    ///         which let a compromised feeToSetter swap the guardian instantly to
    ///         disable arbitrary pairs.
    function setGuardian(address _guardian) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(guardian == address(0), "Use proposeGuardianChange()");
        // AUDIT FIX H-16 / F-94-02: require multisig-class guardian. Constructor
        // now requires non-zero `_guardian`, so this path is only reachable if
        // a later rotation lands `address(0)` and the protocol needs to bootstrap
        // the role again. Reject EOAs (single-key blast radius) and EIP-7702
        // delegated EOAs (look like contracts but aren't).
        uint256 codeLen = _guardian.code.length;
        require(codeLen > 0 && codeLen != 23, "GUARDIAN_NOT_MULTISIG");
        guardian = _guardian;
        emit GuardianSet(address(0), _guardian);
    }

    /// @notice AUDIT R028 H-01: propose a guardian change (takes effect after 48h).
    /// @dev    AUDIT FIX 2026-05-26 [L-26] — guardian rotation to address(0) is now
    ///         REJECTED. Per user decision 2026-05-26 the emergency role must ALWAYS
    ///         exist (a zero guardian leaves the protocol with no instant-disable
    ///         capability, defeating the NEW-A2 design rationale). Rotation to a fresh
    ///         non-zero multisig is the supported path; disabling the role outright is not.
    /// @dev    AUDIT FIX D-AMM-L2: reject same-guardian no-op proposals so a captured
    ///         feeToSetter cannot occupy the GUARDIAN_CHANGE proposal slot for 48h
    ///         and block legitimate rotation. Mirrors the SAME_SETTER guard in
    ///         `proposeFeeToSetter` and the SAME_VALUE pattern across audit fixes.
    function proposeGuardianChange(address _newGuardian) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        // AUDIT FIX 2026-05-26 [L-26] — explicit zero-address reject.
        require(_newGuardian != address(0), "ZERO_GUARDIAN");
        require(_newGuardian != guardian, "SAME_GUARDIAN");
        // AUDIT FIX H-16 / F-94-02 (HIGH): require multisig-class guardian on rotation.
        // The prior `if (_newGuardian != address(0))` carve-out is removed (per L-26 above)
        // so the check is now unconditional.
        uint256 codeLen = _newGuardian.code.length;
        require(codeLen > 0 && codeLen != 23, "GUARDIAN_NOT_MULTISIG");
        pendingGuardian = _newGuardian;
        _propose(GUARDIAN_CHANGE, GUARDIAN_CHANGE_DELAY);
        emit GuardianChangeProposed(guardian, _newGuardian, _executeAfter[GUARDIAN_CHANGE]);
    }

    /// @notice AUDIT R028 H-01: execute a previously proposed guardian change.
    function executeGuardianChange() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        _execute(GUARDIAN_CHANGE);
        address old = guardian;
        guardian = pendingGuardian;
        pendingGuardian = address(0);
        emit GuardianChangeExecuted(old, guardian);
    }

    /// @notice AUDIT R028 H-01: cancel a pending guardian change.
    function cancelGuardianChange() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        address cancelled = pendingGuardian;
        _cancel(GUARDIAN_CHANGE);
        pendingGuardian = address(0);
        emit GuardianChangeCancelled(cancelled);
    }

    /// @notice INSTANT pair disable — no timelock. Callable only by guardian or
    ///         feeToSetter. Intended for active-exploit response. Re-enabling a
    ///         disabled pair still requires the normal 48h timelocked propose path.
    ///
    ///         AUDIT H-2 (HIGH): if a pending PAIR_DISABLE_CHANGE proposal exists
    ///         AND its target value is `false` (i.e. a re-enable), force-cancel
    ///         it so the attacker can't race the guardian and unwind the circuit
    ///         breaker. A pending DISABLE proposal (target value `true`) is left
    ///         in place — it will execute normally and is benign (same end-state),
    ///         and silencing it would amount to a guardian veto over governance.
    /// @dev AUDIT FIX F-30-1 / M-21 (MED): `isPair[pair]` gate prevents a
    ///      captured guardian/setter from polluting `disabledPairs` with
    ///      arbitrary addresses (EOAs, other forks' pairs).
    /// @dev AUDIT FIX H-16 / F-94-02 (HIGH): per-day rate limit
    ///      (`MAX_EMERGENCY_DISABLES_PER_DAY = 3`) caps a single-key compromise
    ///      from "disable every pair in one block" to "at most 3 pairs/day".
    ///      The day index is derived from `block.timestamp / 1 days` (UTC
    ///      rolling window). Combined with the 48h timelock on re-enable, a
    ///      determined captured guardian needs >100 days to disable all 100
    ///      pairs of a typical AMM — far more time than veTOWELI holders need
    ///      to escalate a guardian rotation via `proposeGuardianChange`.
    function emergencyDisablePair(address pair) external {
        require(pair != address(0), "ZERO_ADDRESS");
        require(
            msg.sender == guardian || msg.sender == feeToSetter,
            "NOT_GUARDIAN"
        );
        // AUDIT FIX F-30-1 / M-21 (MED): factory-membership gate.
        if (!isPair[pair]) revert NotAPair();

        // AUDIT FIX H-16 / F-94-02 (HIGH): per-day rate-limit. Day rollover
        // resets the counter; same-day calls increment until the cap is hit.
        //
        // AUDIT FIX TF-031: the cap is GLOBAL (3 per day across all callers and
        // all pairs), so a slot spent is a slot the circuit breaker no longer
        // has. Re-disabling a pair that is ALREADY disabled changes no state,
        // yet it used to consume one of the three — meaning three
        // state-unchanging calls could exhaust the day's budget and leave a
        // real rug undisableable until the next rollover.
        //
        // So: only spend a slot on a call that actually disables something.
        // Same shape and same reasoning as D-AMM-L2 at :698-706, which rejects
        // a same-guardian no-op precisely so a captured key cannot occupy a
        // scarce safety slot with a call that changes nothing.
        //
        // The H-2 force-cancel below stays OUTSIDE this guard on purpose: a
        // repeat call must still be able to cancel a pending RE-ENABLE, which
        // is the one thing it can legitimately change.
        if (!disabledPairs[pair]) {
            uint64 currentDay = uint64(block.timestamp / 1 days);
            if (currentDay != lastDisableDay) {
                // Day rollover — reset counter.
                lastDisableDay = currentDay;
                emergencyDisablesToday = 1;
            } else {
                // Same day — enforce cap before incrementing.
                // AUDIT FIX 2026-05-26 [L-33] — uint8 overflow path is impossible: cap
                // MAX_EMERGENCY_DISABLES_PER_DAY=3 trips at 4, well below uint8 max 255.
                // Solidity 0.8 checked arith would revert if ever reached.
                uint8 nextCount = emergencyDisablesToday + 1;
                if (nextCount > MAX_EMERGENCY_DISABLES_PER_DAY) {
                    revert EmergencyDisableRateLimited();
                }
                emergencyDisablesToday = nextCount;
            }

            disabledPairs[pair] = true;
        }

        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        // H-2: only cancel pending RE-ENABLEs (false), leave pending DISABLEs (true) alone.
        if (_executeAfter[key] != 0 && pendingPairDisableValue[pair] == false) {
            _cancel(key);
            delete pendingPairDisableValue[pair];
            // AUDIT 2026-05-31 [slither unused-return]: EnumerableSet.remove return
            // ignored — entered the branch only because _executeAfter[key]!=0, which
            // means proposePairDisabled previously added `pair`; presence guaranteed.
            // Same convention as _flushPairDisables L486.
            // slither-disable-next-line unused-return
            _pendingPairDisables.remove(pair); // AUDIT FIX 2026-05-26 [H-08]
        }
        emit PairEmergencyDisabled(pair, msg.sender);
    }
}
