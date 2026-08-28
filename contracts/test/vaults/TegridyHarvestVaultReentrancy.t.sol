// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {TegridyHarvestVault} from "../../src/vaults/TegridyHarvestVault.sol";

/// @dev The production asset is a TegridyPair, which has no transfer callback — so the only
///      way to exercise the guards is against a hostile token standing in its place. These
///      mocks exist to prove the guards fire, not to model the real farm.

enum Hook {
    None,
    Deposit,
    Redeem,
    Harvest,
    DeployIdle
}

contract HostileLP is ERC20 {
    address public vault;
    Hook public hook;
    address public token0;
    address public token1;

    constructor(address _token0, address _token1) ERC20("Hostile LP", "hLP") {
        token0 = _token0;
        token1 = _token1;
        _mint(msg.sender, 1_000_000 ether);
    }

    function arm(address _vault, Hook _hook) external {
        vault = _vault;
        hook = _hook;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        Hook h = hook;
        if (h == Hook.None || vault == address(0)) return;
        // Only bite on transfers that cross the vault boundary, so internal mint/burn
        // bookkeeping in setUp does not trip the hook.
        if (from != vault && to != vault) return;
        hook = Hook.None; // one-shot: the assertion is that the first re-entry is rejected
        if (h == Hook.Deposit) {
            TegridyHarvestVault(vault).deposit(1 ether, address(this));
        } else if (h == Hook.Redeem) {
            TegridyHarvestVault(vault).redeem(1, address(this), address(this));
        } else if (h == Hook.DeployIdle) {
            TegridyHarvestVault(vault).deployIdle();
        }
    }
}

contract HostileReward is ERC20 {
    address public vault;
    Hook public hook;

    constructor() ERC20("Hostile Reward", "hRWD") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function arm(address _vault, Hook _hook) external {
        vault = _vault;
        hook = _hook;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        Hook h = hook;
        if (h == Hook.None || vault == address(0)) return;
        if (to != vault) return;
        hook = Hook.None;
        if (h == Hook.Harvest) {
            TegridyHarvestVault(vault).harvest(0, 0);
        } else if (h == Hook.DeployIdle) {
            TegridyHarvestVault(vault).deployIdle();
        } else if (h == Hook.Deposit) {
            TegridyHarvestVault(vault).deposit(1 ether, address(this));
        }
    }
}

contract MockFarm {
    address public stakingToken;
    address public rewardToken;
    uint256 public constant MIN_STAKE = 100e18;
    bool public paused;

    mapping(address => uint256) public rawBalanceOf;
    mapping(address => uint256) public earned;

    constructor(address _stakingToken, address _rewardToken) {
        stakingToken = _stakingToken;
        rewardToken = _rewardToken;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setEarned(address who, uint256 amount) external {
        earned[who] = amount;
    }

    function stake(uint256 amount) external {
        require(!paused, "PAUSED");
        require(amount >= MIN_STAKE, "MIN");
        rawBalanceOf[msg.sender] += amount;
        IERC20(stakingToken).transferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external {
        rawBalanceOf[msg.sender] -= amount;
        IERC20(stakingToken).transfer(msg.sender, amount);
    }

    function getReward() external {
        uint256 owed = earned[msg.sender];
        earned[msg.sender] = 0;
        if (owed > 0) IERC20(rewardToken).transfer(msg.sender, owed);
    }

    function emergencyWithdraw() external {
        uint256 amount = rawBalanceOf[msg.sender];
        rawBalanceOf[msg.sender] = 0;
        earned[msg.sender] = 0;
        IERC20(stakingToken).transfer(msg.sender, amount);
    }
}

contract MockRouter {
    address public immutable WETH;

    constructor(address _weth) {
        WETH = _weth;
    }

    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external
        pure
        returns (uint256[] memory)
    {
        revert("UNREACHABLE_IN_REENTRANCY_SUITE");
    }

    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        pure
        returns (uint256, uint256, uint256)
    {
        revert("UNREACHABLE_IN_REENTRANCY_SUITE");
    }
}

contract TegridyHarvestVaultReentrancyTest is Test {
    HostileLP internal lp;
    HostileReward internal reward;
    ERC20 internal weth;
    MockFarm internal farm;
    MockRouter internal router;
    TegridyHarvestVault internal vault;

    address internal alice = makeAddr("alice");

    function setUp() public {
        weth = new ERC20Stub();
        reward = new HostileReward();
        lp = new HostileLP(address(reward), address(weth));
        farm = new MockFarm(address(lp), address(reward));
        router = new MockRouter(address(weth));

        vault = new TegridyHarvestVault(
            address(lp), address(farm), address(router), address(this), "Hostile Vault", "hVLT"
        );

        lp.transfer(alice, 500_000 ether);
        vm.prank(alice);
        lp.approve(address(vault), type(uint256).max);
    }

    function test_deposit_rejectsReentrantDeposit() public {
        lp.arm(address(vault), Hook.Deposit);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.deposit(1_000 ether, alice);
    }

    function test_withdraw_rejectsReentrantRedeem() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        lp.arm(address(vault), Hook.Redeem);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.withdraw(500 ether, alice, alice);
    }

    function test_withdraw_rejectsReentrantDeployIdle() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        lp.arm(address(vault), Hook.DeployIdle);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.redeem(aliceShares, alice, alice);
    }

    function test_harvest_rejectsReentrantHarvest() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        reward.mint(address(farm), 10 ether);
        farm.setEarned(address(vault), 10 ether);

        reward.arm(address(vault), Hook.Harvest);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.harvest(0, 1);
    }

    function test_harvest_rejectsReentrantDepositFromRewardToken() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        reward.mint(address(farm), 10 ether);
        farm.setEarned(address(vault), 10 ether);

        reward.arm(address(vault), Hook.Deposit);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.harvest(0, 1);
    }

    /// @notice With the hook disarmed the same flows succeed, so the reverts above are the
    ///         guard firing and not an unrelated failure in the harness.
    function test_control_flowsSucceedWithHookDisarmed() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        assertEq(farm.rawBalanceOf(address(vault)), 1_000 ether);

        vm.prank(alice);
        vault.withdraw(500 ether, alice, alice);
        assertEq(vault.totalAssets(), 500 ether);
    }
}

contract ERC20Stub is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
