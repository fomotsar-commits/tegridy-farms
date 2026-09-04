// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  LighthouseLadder — the island's EVM lighthouse, with a lock ladder.
 * @notice A deliberate, minimal FORK of the vendored canonical Synthetix
 *         StakingRewards (contracts/src/vendor/synthetix-staking-rewards/,
 *         provenance D8). The reward engine below is Synthetix's, line for
 *         line, with exactly two expressions changed:
 *
 *           rewardPerToken()  divides by `_totalBoosted`   (was _totalSupply)
 *           earned(account)   multiplies by `_boosted[a]`  (was _balances[a])
 *
 *         so `_balances` / `_totalSupply` keep their canonical meaning — REAL
 *         PRINCIPAL — while lock weight rides alongside in `_boosted`. Locks
 *         live in their own ledger and touch the accumulator only through that
 *         one account-level pair.
 *
 * @dev    WHY A FORK AND NOT A WRAPPER: a wrapper cannot hold the solvency
 *         invariant, because the contract that enforces it must also hold the
 *         principal. Judged unanimously across three independent review lenses
 *         (safety / auditability / fit), 2026-08-30.
 *
 * ─────────────────────────── THE PRINCIPAL PROMISE ───────────────────────────
 *
 * These are SAME-TOKEN pools: you stake X and you earn X. That is what makes a
 * naive locked staker dangerous — reward payouts and staked principal come out
 * of one balance, so an over-generous reward can quietly spend somebody else's
 * deposit and strand the last person out (see the vendor's VENDOR.md).
 *
 * This contract makes principal safety an ON-CHAIN RULE rather than a funding
 * ritual: every reward transfer is capped at the pool's SURPLUS,
 *
 *     surplus = rewardsToken.balanceOf(this) - _totalSupply
 *
 * so no payment can ever push the pool below the principal it owes. From that
 * one rule the exit guarantee follows mechanically: `balanceOf(this)` is never
 * less than `_totalSupply`, therefore a withdrawal of your own principal can
 * never fail for want of balance — not when the vault is empty, not when the
 * reward period ended, not when everyone else exits first.
 *
 * The Solana leg cannot make this promise (its program reverts both claim and
 * unstake while accrued rewards exceed the vault — devnet-proven error 6012,
 * principal held hostage). That failure class is structurally impossible here.
 *
 * ───────────────────────────── THE EXIT HATCHES ──────────────────────────────
 *
 *   withdrawPosition   after the lock ends — principal + rewards, no penalty
 *   earlyExit          before it ends      — principal - 25%, rewards paid
 *   emergencyWithdraw  ALWAYS, any time    — principal only, touching the
 *                                            reward path not at all
 *
 * `emergencyWithdraw` is the last resort and is deliberately ungated by time:
 * it is the hatch for a broken reward token or a wedged accumulator, so gating
 * it behind `lockEnd` would shut it in exactly the case it exists for. It is
 * not a way to dodge the lock — an early emergency exit pays the same 25%
 * penalty; what it buys is an exit that needs nothing from the reward engine.
 *
 * ────────────────────────────── HARDENING NOTES ──────────────────────────────
 *
 * A 10-agent design review (3 designs, 3 judges, 4 adversaries) put three
 * CRITICAL attacks on an earlier draft, all sharing one root: a closed position
 * whose record survived, which `relock()` and a permissionless `decay()` could
 * then resurrect to mint boost weight backed by zero principal, or use to
 * underflow a victim's weight and brick their withdrawal. The answers here are
 * deletions, not additions:
 *
 *   - every close path runs `delete positions[id]`, so a closed id is gone
 *     (the same thing TegridyStaking does, and the reason it never had this);
 *   - there is NO `relock` and NO permissionless `decay`. Climbing the ladder
 *     is withdraw-then-stake, which cannot mint weight from nothing. Boost
 *     therefore never needs to be "kicked" by a stranger;
 *   - every `_boosted` / `_totalBoosted` decrement is FLOORED, so even a
 *     desynchronised ledger degrades into a boost error instead of a panic on
 *     the principal path — a revert there would be the hostage bug again;
 *   - `lockEnd` is bounded and stored in uint64 only after a range check, and
 *     principal is held in uint256 (no downcast on the money path).
 */
contract LighthouseLadderFixed is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== LADDER ========== */

    /// @notice TOWELI PARITY (owner decision 2026-08-30: "shouldn't it follow
    ///         the same thing towelie is doing"). Identical ladder to
    ///         TegridyStaking: a seven-day floor, four years at the top, and a
    ///         0.4x..4.0x boost — a TEN-fold spread between the shortest and
    ///         longest commitment, not the four-fold one an unlocked rung
    ///         would allow. A staker who knows the TOWELI farm meets exactly
    ///         the same ladder on every bungalow.
    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant MAX_LOCK_DURATION = 4 * 365 days;
    uint256 public constant MIN_BOOST_BPS = 4_000;  // 0.4x at 7 days
    uint256 public constant MAX_BOOST_BPS = 40_000; // 4.0x at 4 years
    uint256 public constant BPS = 10_000;
    /// @notice Paid by anyone leaving before their lock ends. It stays in the
    ///         pool as reward budget — no treasury address, no external call,
    ///         nothing to misconfigure, and the people who kept their word are
    ///         the ones it accrues to.
    uint256 public constant EARLY_EXIT_PENALTY_BPS = 2_500; // 25%
    /// @notice Bounds the per-account loop in `positionsOf`.
    uint256 public constant MAX_POSITIONS = 20;

    /* ========== STATE (canonical Synthetix, unchanged in meaning) ========== */

    IERC20 public rewardsToken;
    IERC20 public stakingToken;
    address public rewardsDistribution;
    uint256 public periodFinish = 0;
    uint256 public rewardRate = 0;
    uint256 public rewardsDuration = 60 days;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// @dev REAL principal, exactly as upstream means it.
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    /* ========== STATE (the ladder, added) ========== */

    /// @dev Lock weight. The ONLY new quantity the reward engine reads.
    uint256 private _totalBoosted;
    mapping(address => uint256) private _boosted;

    struct Position {
        address owner;
        uint64 lockEnd;
        uint256 amount;
        uint256 boosted;
    }

    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId = 1;
    mapping(address => uint256[]) private _ids;
    mapping(uint256 => uint256) private _idIndex;

    /* ========== CONSTRUCTOR ========== */

    constructor(address _rewardsDistribution, address _rewardsToken, address _stakingToken) {
        // The solvency theorem is denominated in ONE token; pin that on-chain
        // rather than trusting the deployer (a review finding: nothing else
        // makes `balanceOf - totalSupply` meaningful).
        require(_rewardsToken == _stakingToken, "Lighthouse: same-token pools only");
        require(_rewardsDistribution != address(0), "Lighthouse: no distributor");
        rewardsToken = IERC20(_rewardsToken);
        stakingToken = IERC20(_stakingToken);
        rewardsDistribution = _rewardsDistribution;
    }

    /* ========== VIEWS ========== */

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function totalBoosted() external view returns (uint256) {
        return _totalBoosted;
    }

    function boostedBalanceOf(address account) external view returns (uint256) {
        return _boosted[account];
    }

    /// @notice Every reward the pool may pay right now without touching
    ///         principal. The UI's honest "reward vault" number.
    function rewardSurplus() public view returns (uint256) {
        uint256 bal = rewardsToken.balanceOf(address(this));
        return bal > _totalSupply ? bal - _totalSupply : 0;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function rewardPerToken() public view returns (uint256) {
        // FORK HUNK 1/2: boosted weight is the divisor.
        if (_totalBoosted == 0) {
            return rewardPerTokenStored;
        }
        return
            rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / _totalBoosted;
    }

    function earned(address account) public view returns (uint256) {
        // FORK HUNK 2/2: boosted weight is the multiplier.
        return (_boosted[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    /// @notice Boost in bps for a lock of `duration`. Line for line the same
    ///         interpolation TegridyStaking.calculateBoost uses, so the two
    ///         ladders cannot drift apart.
    function boostFor(uint256 duration) public pure returns (uint256) {
        if (duration <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
        if (duration >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
        uint256 range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
        uint256 boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
        uint256 elapsed = duration - MIN_LOCK_DURATION;
        return MIN_BOOST_BPS + (elapsed * boostRange) / range;
    }

    /// @notice A caller's open position ids. Bounded by MAX_POSITIONS.
    function positionsOf(address account) external view returns (uint256[] memory) {
        return _ids[account];
    }

    /* ========== MUTATIVE ========== */

    /// @notice Open a position. Every stake is its OWN position — there is no
    ///         top-up, so there is no boost blending and no way to buy a high
    ///         multiplier for a short commitment.
    function stake(uint256 amount, uint256 duration) external nonReentrant updateReward(msg.sender) returns (uint256 id) {
        require(amount > 0, "Cannot stake 0");
        require(duration >= MIN_LOCK_DURATION, "Lighthouse: lock too short");
        require(duration <= MAX_LOCK_DURATION, "Lighthouse: lock too long");
        require(_ids[msg.sender].length < MAX_POSITIONS, "Lighthouse: too many positions");

        // Credit only what actually arrived. A fee-on-transfer or rebasing
        // token would otherwise let the ledger claim principal the pool never
        // received, breaking the solvency invariant on the very first stake.
        uint256 before = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakingToken.balanceOf(address(this)) - before;
        require(received > 0, "Lighthouse: no tokens received");

        uint256 boosted = (received * boostFor(duration)) / BPS;
        id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            lockEnd: uint64(block.timestamp + duration),
            amount: received,
            boosted: boosted
        });
        _idIndex[id] = _ids[msg.sender].length;
        _ids[msg.sender].push(id);

        _totalSupply += received;
        _balances[msg.sender] += received;
        _totalBoosted += boosted;
        _boosted[msg.sender] += boosted;

        emit Staked(msg.sender, id, received, duration, boosted);
    }

    /// @notice Close a matured position: principal in full, rewards paid.
    function withdrawPosition(uint256 id) public nonReentrant updateReward(msg.sender) {
        Position memory p = _owned(id);
        require(block.timestamp >= p.lockEnd, "Lighthouse: still locked");
        _payRewards(msg.sender);
        _close(id, p);
        stakingToken.safeTransfer(msg.sender, p.amount);
        emit Withdrawn(msg.sender, id, p.amount, 0);
    }

    /// @notice Leave before the lock ends: principal minus the penalty, plus
    ///         rewards. The penalty stays in the pool as reward budget.
    function earlyExit(uint256 id) public nonReentrant updateReward(msg.sender) {
        Position memory p = _owned(id);
        // The reference's H-3: a matured position must never eat a penalty by
        // accident — send it to the free door instead of silently charging.
        require(block.timestamp < p.lockEnd, "Lighthouse: use withdrawPosition");
        _payRewards(msg.sender);
        _close(id, p);
        uint256 penalty = (p.amount * EARLY_EXIT_PENALTY_BPS) / BPS;
        uint256 out = p.amount - penalty;
        stakingToken.safeTransfer(msg.sender, out);
        emit Withdrawn(msg.sender, id, out, penalty);
    }

    /// @notice THE LAST RESORT. Principal only. Never touches the reward token
    ///         path, never reads the accumulator for a payout, and is open at
    ///         ANY time — including while locked (paying the same penalty) and
    ///         including when rewards are broken, unfunded or wedged.
    /// @dev    No `updateReward` on purpose: this must work even if the reward
    ///         accounting is the thing that is broken. Accrued rewards are
    ///         forfeited by taking this door, and the event says so.
    function emergencyWithdraw(uint256 id) external nonReentrant {
        Position memory p = _owned(id);
        _close(id, p);
        uint256 out = p.amount;
        if (block.timestamp < p.lockEnd) {
            out = p.amount - (p.amount * EARLY_EXIT_PENALTY_BPS) / BPS;
        }
        stakingToken.safeTransfer(msg.sender, out);
        emit EmergencyWithdrawn(msg.sender, id, out);
    }

    /// @notice Claim rewards without closing anything.
    function getReward() public nonReentrant updateReward(msg.sender) {
        _payRewards(msg.sender);
    }

    /* ========== RESTRICTED ========== */

    function notifyRewardAmount(uint256 reward) external onlyRewardsDistribution updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }

        // Upstream compares against the whole balance. In a same-token pool
        // that counts STAKED PRINCIPAL as fundable budget — the hazard named in
        // VENDOR.md. Here the rate is bounded by the SURPLUS, so an over-notify
        // is refused at the door instead of being paid out of deposits.
        require(rewardRate <= rewardSurplus() / rewardsDuration, "Provided reward too high");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward);
    }

    /* ========== INTERNAL ========== */

    function _owned(uint256 id) private view returns (Position memory p) {
        p = positions[id];
        // A closed position is DELETED, so `owner == address(0)` here is the
        // "no such position" case — the three criticals from the design review
        // all began with a record that outlived its close.
        require(p.owner == msg.sender && p.amount > 0, "Lighthouse: not your position");
    }

    /// @dev The one close path. Deletes the record, then floors every weight
    ///      decrement so a desynchronised ledger can never panic here — a
    ///      revert on this path would strand principal, which is the whole
    ///      thing this contract exists to prevent.
    function _close(uint256 id, Position memory p) private {
        uint256 idx = _idIndex[id];
        uint256[] storage list = _ids[p.owner];
        uint256 last = list[list.length - 1];
        list[idx] = last;
        _idIndex[last] = idx;
        list.pop();
        delete _idIndex[id];
        delete positions[id];

        uint256 amt = p.amount > _balances[p.owner] ? _balances[p.owner] : p.amount;
        _balances[p.owner] -= amt;
        _totalSupply -= amt > _totalSupply ? _totalSupply : amt;

        uint256 b = p.boosted > _boosted[p.owner] ? _boosted[p.owner] : p.boosted;
        _boosted[p.owner] -= b;
        _totalBoosted -= b > _totalBoosted ? _totalBoosted : b;
    }

    /// @dev Pays at most the surplus, so principal is never the source of a
    ///      reward. Anything unpayable STAYS owed (it is not zeroed), so a
    ///      later top-up settles it — accrual is never lost, only deferred.
    function _payRewards(address account) private {
        uint256 owed = rewards[account];
        if (owed == 0) return;
        uint256 payable_ = Math.min(owed, rewardSurplus());
        if (payable_ == 0) return;
        rewards[account] = owed - payable_;
        rewardsToken.safeTransfer(account, payable_);
        emit RewardPaid(account, payable_);
    }

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    modifier onlyRewardsDistribution() {
        require(msg.sender == rewardsDistribution, "Caller is not RewardsDistribution contract");
        _;
    }

    /* ========== EVENTS ========== */

    event RewardAdded(uint256 reward);
    event Staked(address indexed user, uint256 indexed id, uint256 amount, uint256 duration, uint256 boosted);
    event Withdrawn(address indexed user, uint256 indexed id, uint256 amount, uint256 penalty);
    event EmergencyWithdrawn(address indexed user, uint256 indexed id, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
}
