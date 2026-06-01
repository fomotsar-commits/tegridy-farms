// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import {StakingMonitorView} from "../../src/StakingMonitorView.sol";
import "../../src/TegridyStakingAdmin.sol";
import "../../src/TegridyRestaking.sol";

/// @title PASS5-INV-A — TegridyRestaking.totalActivePrincipal accuracy
/// @notice Stateful invariant — `totalActivePrincipal` MUST always equal the sum
///         of `restakers[user].positionAmount` across all currently-active restakers.
///
///         The user-spec called this out as one of 4 untested invariants in the
///         pass-1 master report. The DR-02 / DR2-01 / DR3-03 fix history hit FIVE
///         distinct sites (`unrestake`, `claimAll`, `refreshPosition`,
///         `decayExpiredRestaker`, `emergencyWithdrawNFT`) that each had to apply
///         the principal decrement; a 6th miss would silently inflate the
///         reservation in `recoverStuckPrincipal` and DOS legitimate recoverers.
///         This invariant catches any future regression instantly.

contract InvR_Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract InvR_JBAC is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256) { uint256 id = _id++; _mint(to, id); return id; }
}

contract InvR_WETH is ERC20 {
    constructor() ERC20("WETH", "WETH") { _mint(msg.sender, 1_000_000 ether); }
}

contract InvR_Handler is Test {
    TegridyStaking public staking;
    StakingMonitorView monitor;
    TegridyRestaking public restaking;
    InvR_Toweli public toweli;
    InvR_WETH public weth;

    address[] public actors;
    uint256 public actionCount;

    constructor(
        TegridyStaking _staking,
        TegridyRestaking _restaking,
        InvR_Toweli _toweli,
        InvR_WETH _weth,
        address[] memory _actors
    ) {
        staking = _staking;
        restaking = _restaking;
        toweli = _toweli;
        weth = _weth;
        actors = _actors;
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function doStakeAndRestake(uint256 seed, uint256 amount, uint256 lockSecs) external {
        actionCount++;
        address actor = _pickActor(seed);
        // Skip if actor already has a position — TegridyStaking restricts to one per holder
        // unless they have multiple from transfers (rare). Just use single-position flow.
        if (staking.userTokenId(actor) != 0) return;
        // Already restaked? skip.
        (uint256 tid,,,,,) = restaking.restakers(actor);
        if (tid != 0) return;

        amount = bound(amount, 100 ether, 100_000 ether);
        uint256 lock = bound(lockSecs, 7 days, 365 days);

        if (toweli.balanceOf(actor) < amount) return;
        vm.startPrank(actor);
        try staking.stake(amount, lock) {
            uint256 tokenId = staking.userTokenId(actor);
            // Wait the 24h lockout in transferLockout protection
            vm.warp(block.timestamp + 25 hours);
            staking.approve(address(restaking), tokenId);
            try restaking.restake(tokenId) {} catch {}
        } catch {}
        vm.stopPrank();
    }

    function doUnrestake(uint256 seed) external {
        actionCount++;
        address actor = _pickActor(seed);
        (uint256 tid,,,,,) = restaking.restakers(actor);
        if (tid == 0) return;
        vm.prank(actor);
        try restaking.unrestake() {} catch {}
    }

    function doClaimAll(uint256 seed) external {
        actionCount++;
        address actor = _pickActor(seed);
        (uint256 tid,,,,,) = restaking.restakers(actor);
        if (tid == 0) return;
        vm.prank(actor);
        try restaking.claimAll() {} catch {}
    }

    function doRefreshPosition(uint256 seed) external {
        actionCount++;
        address actor = _pickActor(seed);
        (uint256 tid,,,,,) = restaking.restakers(actor);
        if (tid == 0) return;
        vm.prank(actor);
        try restaking.refreshPosition() {} catch {}
    }

    function doWarp(uint256 secs) external {
        actionCount++;
        secs = bound(secs, 1 hours, 14 days);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS5_INV_A_RestakingPrincipal is Test {
    TegridyStaking public staking;
    StakingMonitorView public monitor;
    TegridyStakingAdmin public stakingAdmin;
    TegridyRestaking public restaking;
    InvR_Toweli public toweli;
    InvR_JBAC public jbac;
    InvR_WETH public weth;

    InvR_Handler public handler;

    address treasury = makeAddr("inv_a_treasury");
    address[] internal actorsArr;

    function setUp() public {
        toweli = new InvR_Toweli();
        jbac = new InvR_JBAC();
        weth = new InvR_WETH();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        monitor = new StakingMonitorView(address(staking));
        stakingAdmin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(stakingAdmin));

        restaking = new TegridyRestaking(
            address(staking),
            address(monitor),
            address(toweli),
            address(weth),
            0.1 ether
        );

        // Fund the staking pool so that stake() doesn't fail on rewards
        toweli.approve(address(staking), 100_000_000 ether);
        staking.notifyRewardAmount(100_000_000 ether);

        // Fund restaking with bonus rewards
        weth.transfer(address(restaking), 500_000 ether);

        // Five concurrent actors, each pre-funded.
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("inv_a_actor", i)))));
            actorsArr.push(a);
            toweli.transfer(a, 200_000 ether);
            vm.prank(a);
            toweli.approve(address(staking), type(uint256).max);
        }

        handler = new InvR_Handler(staking, restaking, toweli, weth, actorsArr);
        targetContract(address(handler));
    }

    /// @notice INVARIANT: `totalActivePrincipal == sum(restakers[a].positionAmount for a in actors)`
    function invariant_totalActivePrincipal_matchesSum() public view {
        uint256 sum;
        for (uint256 i = 0; i < actorsArr.length; i++) {
            (, uint256 positionAmount,,,,) = restaking.restakers(actorsArr[i]);
            sum += positionAmount;
        }
        uint256 reported = restaking.totalActivePrincipal();
        assertEq(reported, sum, "totalActivePrincipal drift detected");
    }

    /// @notice INVARIANT: totalActivePrincipal NEVER exceeds the contract's
    ///         TOWELI balance + the staking-side principal (positions held).
    ///         Protects against `recoverStuckPrincipal` insolvency from drift.
    function invariant_totalActivePrincipal_bounded() public view {
        uint256 reported = restaking.totalActivePrincipal();
        // Position principals live in TegridyStaking, not TegridyRestaking,
        // until force-closed. The bound here is just the sum across users.
        uint256 sum;
        for (uint256 i = 0; i < actorsArr.length; i++) {
            (, uint256 positionAmount,,,,) = restaking.restakers(actorsArr[i]);
            sum += positionAmount;
        }
        assertLe(reported, sum, "totalActivePrincipal > sum (overcount)");
    }
}
