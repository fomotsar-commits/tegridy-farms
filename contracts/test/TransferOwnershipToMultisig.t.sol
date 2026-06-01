// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../script/TransferOwnershipToMultisig.s.sol";

/// @dev Minimal Ownable2Step mock. Mirrors the surface the script consumes
///      (owner / transferOwnership). Constructor takes initial owner so the
///      test can wire the deployer correctly.
contract MockOwnable2Step {
    address public owner;
    address public pendingOwner;

    constructor(address _initialOwner) {
        owner = _initialOwner;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "NOT_OWNER");
        pendingOwner = newOwner;
    }
}

/// @dev Mimics TegridyFactory's feeToSetter / propose-accept pattern.
contract MockFactoryAuth {
    address public feeToSetter;
    address public pendingFeeToSetter;

    constructor(address _initialSetter) {
        feeToSetter = _initialSetter;
    }

    function proposeFeeToSetter(address _newSetter) external {
        require(msg.sender == feeToSetter, "NOT_SETTER");
        pendingFeeToSetter = _newSetter;
    }
}

/// @dev Stand-in for the Safe multisig — just needs to be a contract (have
///      code) so the script's `multisig.code.length > 0` guard passes.
contract DummyMultisig {}

contract TransferOwnershipToMultisigTest is Test {
    TransferOwnershipToMultisig script;
    DummyMultisig multisig;

    MockOwnable2Step staking;
    MockOwnable2Step swapFeeRouter;
    MockOwnable2Step polAccumulator;
    MockFactoryAuth factory;

    address deployer;

    function setUp() public {
        deployer = makeAddr("deployer");
        multisig = new DummyMultisig();

        // All mocks owned by the deployer, as if they were just deployed.
        staking        = new MockOwnable2Step(deployer);
        swapFeeRouter  = new MockOwnable2Step(deployer);
        polAccumulator = new MockOwnable2Step(deployer);
        factory        = new MockFactoryAuth(deployer);

        script = new TransferOwnershipToMultisig();
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _mvpOwnables() internal view returns (address[] memory, string[] memory) {
        address[] memory a = new address[](3);
        string[] memory l = new string[](3);
        a[0] = address(staking);        l[0] = "TegridyStaking";
        a[1] = address(swapFeeRouter);  l[1] = "SwapFeeRouter";
        a[2] = address(polAccumulator); l[2] = "POLAccumulator";
        return (a, l);
    }

    // ─── Tests ────────────────────────────────────────────────────────

    /// @notice Happy path — all 3 ownable contracts get pendingOwner set to
    ///         multisig; factory gets pendingFeeToSetter set to multisig.
    function test_runForTest_transfersOwnershipAndProposesSetter() public {
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        script.runForTest(deployer, address(multisig), owns, labels, address(factory));

        assertEq(staking.pendingOwner(),         address(multisig), "staking pendingOwner");
        assertEq(swapFeeRouter.pendingOwner(),   address(multisig), "swapFeeRouter pendingOwner");
        assertEq(polAccumulator.pendingOwner(),  address(multisig), "polAccumulator pendingOwner");
        assertEq(factory.pendingFeeToSetter(),   address(multisig), "factory pendingFeeToSetter");

        // owner() not yet changed — that requires acceptOwnership from the multisig.
        assertEq(staking.owner(),       deployer, "staking owner unchanged until acceptance");
        assertEq(factory.feeToSetter(), deployer, "factory setter unchanged until acceptance");
    }

    /// @notice MULTISIG must be non-zero.
    function test_runForTest_revertsOnZeroMultisig() public {
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        vm.expectRevert(bytes("MULTISIG required"));
        script.runForTest(deployer, address(0), owns, labels, address(factory));
    }

    /// @notice MULTISIG must be a contract (Safe), not an EOA. Catches the
    ///         classic mistake of passing a hardware-wallet address directly.
    function test_runForTest_revertsOnEOAMultisig() public {
        address eoa = makeAddr("anEOA");
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        vm.expectRevert(bytes("MULTISIG must be a contract (Safe)"));
        script.runForTest(deployer, eoa, owns, labels, address(factory));
    }

    /// @notice If the broadcaster isn't the owner, abort BEFORE the broadcast
    ///         (catches typo'd entries pointing at unrelated contracts that
    ///         happen to expose transferOwnership).
    function test_runForTest_revertsOnWrongOwner() public {
        address notOwner = makeAddr("notTheDeployer");
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        vm.expectRevert();  // long string.concat message; just confirm it reverts
        script.runForTest(notOwner, address(multisig), owns, labels, address(factory));
    }

    /// @notice Same as above but specifically for the feeToSetter path.
    function test_runForTest_revertsOnWrongFactorySetter() public {
        MockFactoryAuth strayFactory = new MockFactoryAuth(makeAddr("strayer"));
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        vm.expectRevert();
        script.runForTest(deployer, address(multisig), owns, labels, address(strayFactory));
    }

    /// @notice address(0) entries in the inventory are silently skipped —
    ///         lets the script run for partial-deploy scenarios without
    ///         requiring inventory edits.
    function test_runForTest_skipsZeroAddressEntries() public {
        address[] memory owns = new address[](3);
        string[] memory labels = new string[](3);
        owns[0] = address(staking);    labels[0] = "TegridyStaking";
        owns[1] = address(0);          labels[1] = "MISSING";        // skipped
        owns[2] = address(0);          labels[2] = "MISSING";        // skipped

        script.runForTest(deployer, address(multisig), owns, labels, address(factory));

        assertEq(script.ownableCount(), 1, "only 1 entry should survive");
        assertEq(staking.pendingOwner(),       address(multisig), "staking transferred");
        assertEq(swapFeeRouter.pendingOwner(),  address(0),       "swapFeeRouter untouched");
        assertEq(polAccumulator.pendingOwner(), address(0),       "polAccumulator untouched");
        assertEq(factory.pendingFeeToSetter(),  address(multisig), "factory still transferred");
    }

    /// @notice Factory optional — passing address(0) for the factory just
    ///         skips the feeToSetter call.
    function test_runForTest_optionalFactory() public {
        (address[] memory owns, string[] memory labels) = _mvpOwnables();
        script.runForTest(deployer, address(multisig), owns, labels, address(0));

        // Factory untouched
        assertEq(factory.pendingFeeToSetter(), address(0), "factory not touched");
        // Ownables still migrated
        assertEq(staking.pendingOwner(), address(multisig));
    }

    /// @notice Calling runForTest twice in a row should not corrupt inventory
    ///         state. _collect / inventory reset must zero on every entry.
    function test_runForTest_idempotentOnReplay() public {
        (address[] memory owns, string[] memory labels) = _mvpOwnables();

        script.runForTest(deployer, address(multisig), owns, labels, address(factory));
        // Re-run — pre-check still passes because owner is still deployer
        // (acceptOwnership is the multisig's job, not done in this test).
        script.runForTest(deployer, address(multisig), owns, labels, address(factory));

        // Inventory size still matches input length (3) — not doubled.
        assertEq(script.ownableCount(), 3, "inventory not doubled on re-run");
        assertEq(staking.pendingOwner(), address(multisig), "still set");
    }

    /// @notice The ownable + label arrays must agree in length.
    function test_runForTest_revertsOnLengthMismatch() public {
        address[] memory owns = new address[](2);
        string[] memory labels = new string[](3);
        owns[0] = address(staking);
        owns[1] = address(swapFeeRouter);
        labels[0] = "TegridyStaking";
        labels[1] = "SwapFeeRouter";
        labels[2] = "extra";

        vm.expectRevert(bytes("ownables/labels length mismatch"));
        script.runForTest(deployer, address(multisig), owns, labels, address(factory));
    }
}
