// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./TegridyPair.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title TegridyFactory — Creates and manages AMM liquidity pools
/// @notice Fork of Uniswap V2 Factory. Creates TegridyPair pools for any token pair.
///
///         Features:
///         - Create pools for any ERC20 pair (PEPE/ETH, USDC/ETH, TOWELI/USDT, etc.)
///         - Protocol fee (0.05% of swap volume) sent to feeTo address
///         - Unlimited pools — add any pair anytime
///         - Each pool is a TegridyPair contract with its own LP token
contract TegridyFactory is TimelockAdmin {

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
    uint256 public constant FEE_TO_SETTER_DELAY = 48 hours;
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

    // ─── AUDIT R028 H-01 — appended to preserve original storage layout ───
    /// @dev Pending value for the timelocked guardian rotation flow. Placed at
    ///      the end of storage so existing test cheats and any external slot-
    ///      based readers continue to work against the original layout.
    address public pendingGuardian;

    constructor(address _feeToSetter, address _feeTo) {
        // AUDIT FIX v2: Zero-address checks prevent permanent lockout of fee configuration
        require(_feeToSetter != address(0), "ZERO_SETTER");
        require(_feeTo != address(0), "ZERO_FEE_TO");
        feeToSetter = _feeToSetter;
        feeTo = _feeTo;
        emit FactoryInitialized(_feeToSetter, _feeTo);
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
        require(token0.code.length > 0 && token1.code.length > 0, "NOT_CONTRACT");
        // A4-M-10: Reject ERC-777 tokens — they have transfer callbacks that enable
        // cross-contract reentrancy with stale reserves. Check for ERC-1820 registry
        // introspection (ERC-777 tokens register their tokensReceived hook via ERC-1820).
        // Also reject ERC-165 supportsInterface for ERC-777 token interface ID (0xe58e113c).
        _rejectERC777(token0);
        _rejectERC777(token1);
        require(getPair[token0][token1] == address(0), "PAIR_EXISTS");

        // Deploy new pair contract
        bytes memory bytecode = type(TegridyPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        require(pair != address(0), "CREATE2_FAILED");

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

    /// @notice Cancel a pending feeTo change proposal
    function cancelFeeToChange() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
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
        emit FeeToSetterAccepted(oldSetter, feeToSetter);
    }

    /// @notice AUDIT FIX: Cancel a pending feeToSetter proposal.
    ///         Consistent with cancelFeeToChange() pattern.
    function cancelFeeToSetterProposal() external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(pendingFeeToSetter != address(0), "NO_PENDING_PROPOSAL");
        address cancelled = pendingFeeToSetter;
        pendingFeeToSetter = address(0);
        feeToSetterChangeTime = 0;
        emit FeeToSetterProposalCancelled(cancelled);
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

        // ERC-777 token interface ID = 0xe58e113c
        // AUDIT FIX D-AMM-INFO2: 30k gas cap (see function-level NatSpec).
        (bool ok, bytes memory result) = token.staticcall{gas: 30_000}(
            abi.encodeWithSelector(0x01ffc9a7, bytes4(0xe58e113c)) // supportsInterface(0xe58e113c)
        );
        if (ok && result.length >= 32) {
            bool supported = abi.decode(result, (bool));
            require(!supported, "ERC777_NOT_SUPPORTED");
        }

        // Check for granularity() — mandatory ERC-777 function not found in standard ERC-20.
        // If the token implements granularity(), it is likely an ERC-777 token.
        // AUDIT FIX D-AMM-INFO2: 30k gas cap.
        (bool grOk, bytes memory grResult) = token.staticcall{gas: 30_000}(
            abi.encodeWithSelector(bytes4(keccak256("granularity()")))
        );
        if (grOk && grResult.length >= 32) {
            revert("ERC777_NOT_SUPPORTED");
        }

        // AUDIT NEW-A9 (MEDIUM): ERC-1820 has MULTIPLE hook interfaces — `ERC777Token`,
        // `ERC777TokensRecipient`, and `ERC777TokensSender`. The prior check covered
        // only the first. A token could register `ERC777TokensSender` alone (which
        // fires on outgoing transfers from holders — including pairs transferring
        // output tokens) without registering the full `ERC777Token` interface. Check
        // all three to close the gap.
        address ERC1820_REGISTRY = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
        if (ERC1820_REGISTRY.code.length > 0) {
            bytes32[3] memory hashes = [
                keccak256("ERC777Token"),
                keccak256("ERC777TokensRecipient"),
                keccak256("ERC777TokensSender")
            ];
            for (uint256 i = 0; i < 3; i++) {
                // AUDIT FIX D-AMM-INFO2: 30k gas cap.
                (bool regOk, bytes memory regResult) = ERC1820_REGISTRY.staticcall{gas: 30_000}(
                    abi.encodeWithSelector(0xaabbb8ca, token, hashes[i])
                );
                if (regOk && regResult.length >= 32) {
                    address implementer = abi.decode(regResult, (address));
                    require(implementer == address(0), "ERC777_NOT_SUPPORTED");
                }
            }
        }
    }

    /// @notice AUDIT FIX L-29: Block or unblock a token (timelocked for consistency)
    function proposeTokenBlocked(address token, bool blocked) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        pendingTokenBlockValue[token] = blocked;
        _propose(key, TOKEN_BLOCK_DELAY);
        emit TokenBlockProposed(token, blocked, _executeAfter[key]);
    }

    function executeTokenBlocked(address token) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        _execute(key);
        blockedTokens[token] = pendingTokenBlockValue[token];
        delete pendingTokenBlockValue[token];
        emit TokenBlocked(token, blockedTokens[token]);
    }

    function cancelTokenBlocked(address token) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        _cancel(key);
        delete pendingTokenBlockValue[token];
        emit TokenBlockCancelled(token);
    }

    /// @notice Legacy view helper for test compatibility
    function pendingTokenBlockTime(address token) external view returns (uint256) {
        bytes32 key = keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token));
        return _executeAfter[key];
    }

    /// @dev DEPRECATED: Use proposeTokenBlocked() + executeTokenBlocked()
    function setTokenBlocked(address, bool) external pure {
        revert("Use proposeTokenBlocked()");
    }

    /// @notice Propose disabling or re-enabling a pair (timelocked, owner-only)
    function proposePairDisabled(address pair, bool disabled) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(pair != address(0), "ZERO_ADDRESS");
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        pendingPairDisableValue[pair] = disabled;
        _propose(key, PAIR_DISABLE_DELAY);
        emit PairDisableProposed(pair, disabled, _executeAfter[key]);
    }

    /// @notice Execute a previously proposed pair disable/enable after timelock
    function executePairDisabled(address pair) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        _execute(key);
        disabledPairs[pair] = pendingPairDisableValue[pair];
        delete pendingPairDisableValue[pair];
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
        guardian = _guardian;
        emit GuardianSet(address(0), _guardian);
    }

    /// @notice AUDIT R028 H-01: propose a guardian change (takes effect after 48h).
    ///         _newGuardian == address(0) is allowed and disables emergency powers.
    /// @dev    AUDIT FIX D-AMM-L2: reject same-guardian no-op proposals so a captured
    ///         feeToSetter cannot occupy the GUARDIAN_CHANGE proposal slot for 48h
    ///         and block legitimate rotation. Mirrors the SAME_SETTER guard in
    ///         `proposeFeeToSetter` and the SAME_VALUE pattern across audit fixes.
    function proposeGuardianChange(address _newGuardian) external {
        require(msg.sender == feeToSetter, "FORBIDDEN");
        require(_newGuardian != guardian, "SAME_GUARDIAN");
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
    function emergencyDisablePair(address pair) external {
        require(pair != address(0), "ZERO_ADDRESS");
        require(
            msg.sender == guardian || msg.sender == feeToSetter,
            "NOT_GUARDIAN"
        );
        disabledPairs[pair] = true;

        bytes32 key = keccak256(abi.encodePacked(PAIR_DISABLE_CHANGE, pair));
        // H-2: only cancel pending RE-ENABLEs (false), leave pending DISABLEs (true) alone.
        if (_executeAfter[key] != 0 && pendingPairDisableValue[pair] == false) {
            _cancel(key);
            delete pendingPairDisableValue[pair];
        }
        emit PairEmergencyDisabled(pair, msg.sender);
    }
}
