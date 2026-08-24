// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";

/// @dev The one function SequencerCheck consumes, shaped exactly like Chainlink's
///      AggregatorV3Interface so the forward target can be a real Chainlink feed.
interface IAggregatorV3Minimal {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title  AttestedSequencerUptimeFeed — a guardian-attested stand-in for a
///         Chainlink L2 Sequencer Uptime Feed, on chains Chainlink has not
///         reached yet.
///
/// @notice WHY THIS EXISTS. SequencerCheck (audit H-9) refuses a zero feed on any
///         chain except Ethereum mainnet, so every gated path — SwapFeeRouter fee
///         conversion, TegridyDropV2 dutch windows, TegridyTWAP consult — REVERTS
///         on an L2 deployed without a feed. Robinhood Chain (4663) has no
///         Chainlink sequencer uptime feed at the time of writing. The choice is
///         therefore: no leg on that chain at all, or this contract. This contract
///         is the smallest honest bridge: it speaks the exact Chainlink uptime-feed
///         dialect (`answer` 0 = up / 1 = down, `startedAt` = when the current
///         answer was set, so consumers' post-resume grace windows work unchanged),
///         with the answer set by the protocol's own emergency role instead of
///         Chainlink's oracle network.
///
/// @notice WHAT IT HONESTLY IS AND IS NOT. This is ATTESTED, not observed: if the
///         attestor never flips it during a real sequencer outage, consumers get no
///         post-resume grace period and may read pre-outage AMM state — the exact
///         risk Chainlink's automation removes. That residual is accepted and
///         bounded: the attestor is the PAUSE_GUARDIAN hot Safe, whose existing job
///         (guardianPause) is already "notice an incident and act", and the moment
///         Chainlink ships a real feed the owner one-shots `forwardTo(feed)` and
///         this contract becomes a pure passthrough forever — attestation surface
///         gone, no consumer redeploys needed. That forwarding is the entire reason
///         consumers point at THIS address rather than waiting: TegridyTWAP stores
///         its feed as an immutable, so pointing it at Chainlink later would
///         otherwise mean redeploying the TWAP.
///
/// @dev    Roles mirror the deploy scripts' split: owner = MULTISIG (governance
///         Safe, may rotate the attestor and perform the one-shot forward),
///         attestor = PAUSE_GUARDIAN (hot Safe, may only flip the status). Both
///         must be multisig-class; the codeLen ∉ {0, 23} rule is enforced on every
///         role write, same as TegridyFactory.proposeGuardianChange.
contract AttestedSequencerUptimeFeed is OwnableNoRenounce {
    /// @notice Hot role allowed to flip the attested status. PAUSE_GUARDIAN class.
    address public attestor;

    /// @notice One-shot forward target. Non-zero means this contract is a pure
    ///         passthrough to a real Chainlink feed and all manual state is dead.
    address public chainlinkFeed;

    int256 private _answer; // 0 = up, 1 = down (Chainlink uptime-feed semantics)
    uint256 private _startedAt; // when the CURRENT answer was set
    uint80 private _roundId; // bumped on every flip so answeredInRound tracks

    event StatusAttested(bool indexed down, uint256 startedAt, uint80 roundId);
    event AttestorSet(address indexed oldAttestor, address indexed newAttestor);
    event ForwardedToChainlink(address indexed feed);

    error NotAttestor();
    error SameStatus();
    error SameAttestor();
    error AlreadyForwarded();
    error NotMultisigClass(address account);
    error ForwardTargetInvalid(address feed);

    /// @param _attestor      PAUSE_GUARDIAN-class hot Safe that flips the status.
    /// @param _initialOwner  MULTISIG-class Safe that owns rotation + forwardTo,
    ///                       FROM CONSTRUCTION. Not the deployer: ownership of the
    ///                       irreversible one-shot `forwardTo` must never sit with
    ///                       an EOA, not even for the length of an acceptance
    ///                       window — the same construct-with-final-roles lesson
    ///                       as the TegridyFactory guardian (M6/F-30-10).
    constructor(address _attestor, address _initialOwner) OwnableNoRenounce(_initialOwner) {
        _requireMultisigClass(_attestor);
        _requireMultisigClass(_initialOwner);
        attestor = _attestor;
        // Deploy-time state: up, as of now. Consumers with a grace window will
        // treat the first `gracePeriod` after deploy as post-resume settling,
        // which is the conservative direction (reads reject, nothing misprices).
        _answer = 0;
        _startedAt = block.timestamp;
        _roundId = 1;
        emit StatusAttested(false, block.timestamp, 1);
    }

    /// @notice Chainlink AggregatorV3Interface subset. Never reverts in manual
    ///         mode; in forwarded mode it is exactly the Chainlink feed's answer.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        address fwd = chainlinkFeed;
        if (fwd != address(0)) {
            return IAggregatorV3Minimal(fwd).latestRoundData();
        }
        return (_roundId, _answer, _startedAt, _startedAt, _roundId);
    }

    /// @notice Attest the sequencer status. `down = true` marks the sequencer as
    ///         down; flipping back to `false` starts consumers' post-resume grace
    ///         windows (startedAt resets to now), matching Chainlink behaviour.
    /// @dev    Same-value writes are rejected: re-attesting "up" would silently
    ///         reset `startedAt` and RESTART every consumer's grace window — a
    ///         griefing lever with no legitimate use.
    function setStatus(bool down) external {
        if (msg.sender != attestor) revert NotAttestor();
        if (chainlinkFeed != address(0)) revert AlreadyForwarded();
        int256 next = down ? int256(1) : int256(0);
        if (next == _answer) revert SameStatus();
        _answer = next;
        _startedAt = block.timestamp;
        unchecked {
            _roundId += 1;
        }
        emit StatusAttested(down, block.timestamp, _roundId);
    }

    /// @notice Rotate the attestor. Owner-gated, multisig-class enforced.
    function setAttestor(address _newAttestor) external onlyOwner {
        _requireMultisigClass(_newAttestor);
        if (_newAttestor == attestor) revert SameAttestor();
        emit AttestorSet(attestor, _newAttestor);
        attestor = _newAttestor;
    }

    /// @notice ONE-SHOT: point this contract at the real Chainlink sequencer
    ///         uptime feed once Chainlink ships one on this chain. Irreversible by
    ///         design — after this, no role here can influence the answer again.
    /// @dev    The target is validated by actually calling it AND by holding its
    ///         round to every field SequencerCheck enforces — not just the answer.
    ///         A zero-state round (0,0,0,0,0), an `answeredInRound < roundId`
    ///         round, or a future-dated `updatedAt` all pass an answer-only check
    ///         and then hard-fail SequencerCheck forever; with this slot one-shot
    ///         and every consumer slot immutable, that would brick fee conversion,
    ///         the TWAP, and every live drop clone with no recovery path (the
    ///         H-13 failure shape, permanent edition). Non-Chainlink aggregator
    ///         clones — the realistic target class on a chain Chainlink has not
    ///         reached — commonly return zero tuples instead of reverting while
    ///         uninitialized, which is exactly the state this refuses.
    function forwardTo(address feed) external onlyOwner {
        if (chainlinkFeed != address(0)) revert AlreadyForwarded();
        _requireMultisigClass(feed); // rejects zero, EOA, 7702-delegated EOA
        (uint80 roundId, int256 a, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3Minimal(feed).latestRoundData();
        // Mirror SequencerCheck's gates verbatim: answer dialect, initialized
        // round, sane clock, answer not pre-dating its round.
        if (a != 0 && a != 1) revert ForwardTargetInvalid(feed);
        if (updatedAt == 0 || startedAt == 0) revert ForwardTargetInvalid(feed);
        if (updatedAt > block.timestamp) revert ForwardTargetInvalid(feed);
        if (answeredInRound < roundId) revert ForwardTargetInvalid(feed);
        chainlinkFeed = feed;
        emit ForwardedToChainlink(feed);
    }

    function _requireMultisigClass(address account) private view {
        uint256 codeLen = account.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotMultisigClass(account);
    }
}
