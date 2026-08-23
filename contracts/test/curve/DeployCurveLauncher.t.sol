// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployCurveLauncherScript} from "../../script/curve/DeployCurveLauncher.s.sol";
import {TegridyCurveLauncher} from "../../src/curve/TegridyCurveLauncher.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";

contract MockWETHForScript {
    function deposit() external payable {}

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

// Has code but does NOT serve getPair — the fat-fingered-FACTORY case CV-1b exists for.
contract NotAFactory {
    fallback() external {
        revert("nope");
    }
}

contract DeployCurveLauncherScriptTest is Test {
    DeployCurveLauncherScript internal script;
    TegridyFactory internal factory;
    MockWETHForScript internal weth;

    address internal constant MULTISIG = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant CUSTODY = address(0xEC0);
    address internal constant TREASURY = address(0x51ED);

    function setUp() public {
        script = new DeployCurveLauncherScript();
        factory = new TegridyFactory(MULTISIG, address(0x7EA5), GUARDIAN);
        weth = new MockWETHForScript();
        // Roles must be contracts (CV-3): give the test constants bytecode.
        vm.etch(MULTISIG, hex"60006000fd");
        vm.etch(GUARDIAN, hex"60006000fd");
        vm.etch(CUSTODY, hex"60006000fd");
        vm.etch(TREASURY, hex"60006000fd");
    }

    function _config() internal view returns (DeployCurveLauncherScript.Config memory cfg) {
        cfg.factory = address(factory);
        cfg.weth = address(weth);
        cfg.multisig = MULTISIG;
        cfg.pauseGuardian = GUARDIAN;
        cfg.treasury = TREASURY;
        cfg.launch = TegridyCurveLauncher.LaunchConfig({
            virtualEth: 0.2 ether,
            graduationEth: 3.8 ether,
            feeBps: 100,
            creatorFeeShareBps: 4_000,
            treasuryFeeShareBps: 2_500,
            reserveBps: 500,
            reserveRecipient: CUSTODY
        });
    }

    function test_HappyPath_OwnedByMultisigAtBirthWithExactConfig() public {
        TegridyCurveLauncher launcher = script.runForTest(_config());
        // The script's own CV-5..CV-10 read-backs ran; re-pin the two that
        // encode the M6 lesson so a script refactor can't drop them silently.
        assertEq(launcher.owner(), MULTISIG);
        assertEq(launcher.pauseGuardian(), GUARDIAN);
        assertEq(address(launcher.FACTORY()), address(factory));
        assertEq(launcher.launchCount(), 0);
    }

    function test_RefusesFactoryWithoutGetPair() public {
        DeployCurveLauncherScript.Config memory cfg = _config();
        cfg.factory = address(new NotAFactory());
        // The probe call itself reverts inside the target ("nope"), which is
        // exactly the loud failure the operator should see.
        vm.expectRevert();
        script.runForTest(cfg);
    }

    function test_RefusesEOARolesForMultisigAndGuardian() public {
        DeployCurveLauncherScript.Config memory cfg = _config();
        cfg.multisig = address(0xBEEF); // no code
        vm.expectRevert(bytes("CV-3: MULTISIG must be a contract (Safe)"));
        script.runForTest(cfg);

        cfg = _config();
        cfg.pauseGuardian = address(0xBEEF);
        vm.expectRevert(bytes("CV-3b: PAUSE_GUARDIAN must be a contract (Safe)"));
        script.runForTest(cfg);
    }

    function test_ReserveRecipientRejectsZeroButAcceptsOwnerEOA() public {
        // Zero recipient with a live reserve would burn 3.69% of every launch.
        DeployCurveLauncherScript.Config memory cfg = _config();
        cfg.launch.reserveRecipient = address(0);
        vm.expectRevert(
            bytes("CV-3c: RESERVE_RECIPIENT is the zero address (would burn the reserve)")
        );
        script.runForTest(cfg);

        // The owner's explicit operator EOA is accepted (with a deploy-time
        // warning), not hard-rejected — a legitimate, reversible policy choice.
        cfg = _config();
        cfg.launch.reserveRecipient = address(0xEA00); // an EOA (no code)
        TegridyCurveLauncher launcher = script.runForTest(cfg);
        (,,,,,, address reserveRecipient) = launcher.launchConfig();
        assertEq(reserveRecipient, address(0xEA00));
    }

    function test_RefusesDustGraduationTarget() public {
        DeployCurveLauncherScript.Config memory cfg = _config();
        cfg.launch.graduationEth = 0.09 ether;
        cfg.launch.virtualEth = uint128(uint256(0.09 ether) / 19);
        vm.expectRevert(bytes("CV-4: GRADUATION_ETH_WEI < 0.1 ether"));
        script.runForTest(cfg);
    }

    function test_RejectsZeroTreasuryButWarnsOnEOA() public {
        DeployCurveLauncherScript.Config memory cfg = _config();
        cfg.treasury = address(0);
        vm.expectRevert(bytes("CV-3d: TREASURY is the zero address"));
        script.runForTest(cfg);

        // An EOA treasury is accepted (with a warning), like the reserve recipient.
        cfg = _config();
        cfg.treasury = address(0xEA55); // EOA (no code)
        TegridyCurveLauncher launcher = script.runForTest(cfg);
        assertEq(launcher.treasury(), address(0xEA55));
        // The fee-split defaults resolve to 40/25/35 (protocol = remainder).
        (,,, uint16 creatorShare, uint16 treasuryShare,,) = launcher.launchConfig();
        assertEq(creatorShare, 4_000);
        assertEq(treasuryShare, 2_500);
    }
}
