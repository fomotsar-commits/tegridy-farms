// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {TegridyStaking} from "../../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../../src/TegridyStakingJbacVault.sol";
import {TegridyPositionMarket} from "../../src/markets/TegridyPositionMarket.sol";

// ─── Mocks ───────────────────────────────────────────────────────────────────

contract MockToweliPM is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
}

contract MockJbacPM is ERC721 {
    uint256 private _id = 1;

    constructor() ERC721("JungleBay", "JBAC") {}

    function mint(address to) external returns (uint256) {
        _mint(to, _id);
        return _id++;
    }
}

contract MockWethPM {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }
}

/// @dev A plain contract holder. Contracts are exempt from the EOA
///      single-position guard, so this is the only kind of address that can prove
///      TegridyStaking's per-holder position CAP (as opposed to the EOA guard).
contract PlainPositionHolderPM is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function send(address nft, address to, uint256 tokenId) external {
        TegridyStaking(nft).transferFrom(address(this), to, tokenId);
    }
}

/// @dev Buyer contract whose receiver hook reenters the market. Two modes so one
///      contract covers both the same-order and cross-order reentry shapes.
contract ReentrantBuyerPM is IERC721Receiver {
    enum Mode {
        Passive,
        RefillSameOrder,
        CancelOtherOrder,
        FillOtherOrder
    }

    TegridyPositionMarket public immutable market;
    Mode public mode;
    uint256 public targetOrderId;
    uint256 public targetValue;
    /// @notice Set when the reentrant inner call reverted, so a test can prove the
    ///         guard fired rather than the hook simply never running.
    bool public innerReverted;
    bool public hookRan;

    constructor(TegridyPositionMarket _market) {
        market = _market;
    }

    function arm(Mode _mode, uint256 _orderId, uint256 _value) external {
        mode = _mode;
        targetOrderId = _orderId;
        targetValue = _value;
        innerReverted = false;
        hookRan = false;
    }

    function buy(uint256 orderId, uint256 value) external {
        market.fill{value: value}(orderId, address(this));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        hookRan = true;
        if (mode == Mode.RefillSameOrder) {
            try market.fill{value: targetValue}(targetOrderId, address(this)) {}
            catch {
                innerReverted = true;
            }
        } else if (mode == Mode.CancelOtherOrder) {
            try market.cancel(targetOrderId, address(this)) {}
            catch {
                innerReverted = true;
            }
        } else if (mode == Mode.FillOtherOrder) {
            try market.fill{value: targetValue}(targetOrderId, address(this)) {}
            catch {
                innerReverted = true;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// @dev Seller contract that reenters `cancel` from its ETH-proceeds `receive`, i.e.
///      a cancel racing its own fill from inside the fill's payout leg.
contract ReentrantSellerPM is IERC721Receiver {
    TegridyPositionMarket public immutable market;
    uint256 public armedOrderId;
    bool public innerReverted;
    bool public receiveRan;

    constructor(TegridyPositionMarket _market) {
        market = _market;
    }

    function approveAll(address nft) external {
        TegridyStaking(nft).setApprovalForAll(address(market), true);
    }

    function stakeIt(address staking, address token, uint256 amt, uint256 lock) external {
        ERC20(token).approve(staking, type(uint256).max);
        TegridyStaking(staking).stake(amt, lock);
    }

    function listIt(uint256 tokenId, uint256 price) external returns (uint256) {
        return market.list(tokenId, price);
    }

    function arm(uint256 orderId) external {
        armedOrderId = orderId;
        innerReverted = false;
        receiveRan = false;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        receiveRan = true;
        if (armedOrderId != 0) {
            uint256 id = armedOrderId;
            armedOrderId = 0;
            try market.cancel(id, address(this)) {}
            catch {
                innerReverted = true;
            }
        }
    }
}

// ─── Shared fixture ──────────────────────────────────────────────────────────

/// @notice Every suite in `test/markets` binds the market to a REAL TegridyStaking
///         rather than to a mock of it. The guards this market is shaped by
///         (`AlreadyHasPosition`, the 1h transfer rate limit, the 50-position holder
///         cap, and reward settlement on transfer) all live inside staking and its
///         linked libraries; a mock restating them would only ever confirm this file's
///         reading of them, never the deployed behaviour.
abstract contract PositionMarketFixture is Test {
    MockToweliPM internal token;
    MockJbacPM internal jbac;
    MockWethPM internal weth;
    TegridyStaking internal staking;
    TegridyPositionMarket internal market;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal sink = makeAddr("feeSink");

    uint256 internal constant STAKE_AMT = 500_000 ether;
    uint256 internal constant LOCK = 30 days;
    uint256 internal constant PRICE = 3 ether;

    function setUp() public virtual {
        vm.warp(365 days);

        token = new MockToweliPM();
        jbac = new MockJbacPM();
        weth = new MockWethPM();

        // Reward rate deliberately modest. TegridyStaking caps GLOBAL unsettled rewards
        // at `maxUnsettledRewards` (100k TOWELI) and forfeits the overflow, so a
        // fixture running at 1 TOWELI/second saturates that cap within a day and every
        // later settlement silently credits zero — which would make the escrow-yield
        // assertions below pass or fail for a reason that has nothing to do with the
        // market. At this rate the whole suite stays four orders of magnitude clear.
        staking = new TegridyStaking(address(token), address(jbac), treasury, 1e15);
        staking.setJbacVault(address(new TegridyStakingJbacVault(address(jbac), address(staking))));

        market = new TegridyPositionMarket(address(staking), address(weth), address(this));

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(50_000_000 ether);

        _fund(alice);
        _fund(bob);
        _fund(carol);

        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _fund(address who) internal {
        token.transfer(who, 5_000_000 ether);
        vm.startPrank(who);
        token.approve(address(staking), type(uint256).max);
        staking.setApprovalForAll(address(market), true);
        vm.stopPrank();
    }

    /// @dev Stake and return the tokenId. `userTokenId` is the single-pointer the
    ///      staking guard itself reads, so it is the right source here.
    function _stake(address who, uint256 amount, uint256 lock) internal returns (uint256 tokenId) {
        vm.prank(who);
        staking.stake(amount, lock);
        tokenId = staking.userTokenId(who);
    }

    function _stake(address who) internal returns (uint256) {
        return _stake(who, STAKE_AMT, LOCK);
    }

    /// @dev TegridyStaking blocks any transfer within 24h of the stake, so a position
    ///      is not listable until the cooldown clears.
    function _passStakeCooldown() internal {
        vm.warp(block.timestamp + 24 hours + 1);
    }

    /// @dev The listing hop stamps the position's rate limit; a release is blocked for
    ///      an hour after it.
    function _passRateLimit() internal {
        vm.warp(block.timestamp + market.STAKING_TRANSFER_RATE_LIMIT());
    }

    function _listReady(address seller, uint256 price) internal returns (uint256 orderId, uint256 tokenId) {
        tokenId = _stake(seller);
        _passStakeCooldown();
        vm.prank(seller);
        orderId = market.list(tokenId, price);
    }
}
