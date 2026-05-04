// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import {TegridyDropV2} from "../../src/TegridyDropV2.sol";

/// @title PASS6-INV-G — TegridyDropV2 supply + payment conservation
/// @notice Stateful invariants on the TegridyDropV2 mint / phase / refund
///         lifecycle. Five properties enforced after every randomized handler
///         call across 5 actors (4 minters + 1 attacker probing the auth
///         gates) under a mix of PUBLIC + DUTCH_AUCTION + CLOSED phase
///         transitions:
///
///         (G1) Hard supply cap: `totalSupply <= maxSupply` at all times.
///              Closed by the constructor + per-mint `if (totalSupply +
///              quantity > maxSupply) revert ExceedsMaxSupply;` check at
///              TegridyDropV2.sol:505. The randomized handler hammers
///              `mint()` with high-quantity sequences across the 4 minters;
///              this invariant catches any future regression where a phase
///              transition (e.g. resetting per-wallet counters) might bypass
///              the global cap.
///
///         (G2) Wallet-mint accounting: `sum(mintedPerWallet[*]) ==
///              totalSupply`. Per-mint, both counters are bumped by the same
///              `quantity` at TegridyDropV2.sol:552-553. This invariant
///              guards against a refactor that decouples the two (e.g. a
///              new "free mint" path that increments totalSupply but not
///              mintedPerWallet, breaking the maxPerWallet defense).
///
///         (G3) Cancellation rule: `cancelSale` requires `totalSupply == 0`
///              (TegridyDropV2.sol:1006). Once any token is minted, the
///              drop CANNOT be moved into CANCELLED — secondary buyers must
///              not be rugged (AUDIT MICROSCOPE_2026_04_30 H18 / DEEP-DROP-05).
///              The handler attempts cancelSale randomly; the invariant
///              asserts that any observed CANCELLED state implies
///              `totalSupply == 0`.
///
///         (G4) Phase-change auth: only `owner` can call `setMintPhase`.
///              Handler probes with random non-owner actors; the contract
///              MUST revert NotOwner on each non-owner attempt. We track
///              succeeded-from-non-owner via a counter that the invariant
///              asserts stays at 0.
///
///         (G5) Payment conservation in PUBLIC phase: `sum(paidPerWallet[*])
///              <= totalProceeds` (the contract's running ETH-collected
///              tally). totalProceeds is bumped on each successful mint and
///              decremented on refund; under post-V2-DROP-02 rules
///              (cancelSale requires totalSupply == 0), no minter should
///              ever have a non-zero `paidPerWallet[]` paired with a
///              CANCELLED phase. The invariant doubles as a refund-flow
///              check: even if the handler triggers refund() somehow, the
///              identity holds.
///
///         These five together close the V2-DROP-01..04 + DEEP-DROP-02..05 +
///         microscope H18/H19/H20 fix surface against randomized adversarial
///         sequences.

contract InvG_WETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    receive() external payable { _mint(msg.sender, msg.value); }
}

contract InvG_Handler is Test {
    TegridyDropV2 public drop;
    InvG_WETH public weth;
    address public owner;        // creator + initial owner
    address[] public actors;     // includes a non-owner attacker actor
    address public attackerActor; // the actor that should never succeed at owner-only paths

    uint256 public actionCount;

    /// @dev Counter — observed non-owner setMintPhase calls that DID NOT revert.
    ///      Must stay at 0 across the full run. Catches any regression of the
    ///      `onlyOwner` modifier on TegridyDropV2.setMintPhase.
    uint256 public nonOwnerPhaseChangeSucceeded;
    /// @dev Same shape for cancelSale.
    uint256 public nonOwnerCancelSucceeded;

    constructor(
        TegridyDropV2 _drop,
        InvG_WETH _weth,
        address _owner,
        address[] memory _actors,
        address _attacker
    ) {
        drop = _drop;
        weth = _weth;
        owner = _owner;
        actors = _actors;
        attackerActor = _attacker;
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @notice Random `mint` from any actor. Quantities bounded so the
    ///         total-supply / per-wallet caps fire often.
    function doMint(uint256 actorSeed, uint256 qtySeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        uint256 qty = bound(qtySeed, 1, 8);

        TegridyDropV2.MintPhase phase = drop.mintPhase();
        if (
            phase == TegridyDropV2.MintPhase.CLOSED
            || phase == TegridyDropV2.MintPhase.CANCELLED
        ) return;

        // Estimate price generously — over-pay; refund mechanism handles excess.
        uint256 estPrice;
        if (phase == TegridyDropV2.MintPhase.DUTCH_AUCTION) {
            try drop.currentPrice() returns (uint256 p) { estPrice = p; }
            catch { return; }
        } else {
            estPrice = drop.mintPrice();
        }
        uint256 sendValue = estPrice * qty + 0.1 ether;
        vm.deal(a, a.balance + sendValue);

        bytes32[] memory emptyProof;
        vm.prank(a);
        try drop.mint{value: sendValue}(qty, 0, emptyProof) {} catch {}
    }

    /// @notice Random `setMintPhase` from a random caller. We always probe
    ///         with the OWNER (legit) AND with a non-owner ATTACKER on
    ///         alternating calls. Critically: any successful non-owner phase
    ///         change must be flagged by INV-G4.
    function doSetMintPhase(uint256 callerSeed, uint256 phaseSeed) external {
        actionCount++;
        // Phase index in {0..4}. CANCELLED is rejected by the contract from
        // any phase (must use cancelSale). DUTCH_AUCTION requires dutchConfigured;
        // we don't configure dutch in setUp so it'd revert harmlessly.
        TegridyDropV2.MintPhase target = TegridyDropV2.MintPhase(uint8(bound(phaseSeed, 0, 3)));
        // 50/50 split owner vs attacker probe.
        bool useOwner = (callerSeed & 1) == 0;
        address caller = useOwner ? owner : attackerActor;

        if (useOwner) {
            vm.prank(caller);
            try drop.setMintPhase(target) {} catch {}
        } else {
            vm.prank(caller);
            try drop.setMintPhase(target) {
                nonOwnerPhaseChangeSucceeded++;
            } catch {}
        }
    }

    /// @notice Random `cancelSale` from a random caller — owner OR attacker.
    ///         Owner success requires `totalSupply == 0`; attacker success
    ///         is ALWAYS a finding.
    function doCancelSale(uint256 callerSeed) external {
        actionCount++;
        bool useOwner = (callerSeed & 1) == 0;
        if (useOwner) {
            vm.prank(owner);
            try drop.cancelSale() {} catch {}
        } else {
            vm.prank(attackerActor);
            try drop.cancelSale() {
                nonOwnerCancelSucceeded++;
            } catch {}
        }
    }

    /// @notice Random `refund` post-cancellation. Under post-V2-DROP-02 rules
    ///         this always reverts NothingToRefund (cancel requires
    ///         totalSupply == 0 → no paid); we exercise the path anyway so the
    ///         invariant covers the post-cancel branch.
    function doRefund(uint256 actorSeed) external {
        actionCount++;
        address a = _pickActor(actorSeed);
        vm.prank(a);
        try drop.refund() {} catch {}
    }

    function doWarp(uint256 secs) external {
        actionCount++;
        secs = bound(secs, 1 minutes, 7 days);
        vm.warp(block.timestamp + secs);
    }
}

contract PASS6_INV_G_DropV2Supply is Test {
    TegridyDropV2 public drop;
    InvG_WETH public weth;
    InvG_Handler public handler;

    uint256 public constant MAX_SUPPLY = 50;
    uint256 public constant MINT_PRICE = 0.05 ether;
    uint256 public constant MAX_PER_WALLET = 10;
    uint16 public constant PLATFORM_FEE_BPS = 500;
    uint16 public constant ROYALTY_BPS = 500;

    address creator = makeAddr("inv_g_creator");
    address platform = makeAddr("inv_g_platform");
    address[] internal actorsArr;
    address attackerActor = makeAddr("inv_g_attacker");

    function setUp() public {
        weth = new InvG_WETH();

        // Use Clones because TegridyDropV2 disables initializers in its
        // constructor (factory-deployment pattern).
        address impl = address(new TegridyDropV2());
        drop = TegridyDropV2(payable(Clones.clone(impl)));

        TegridyDropV2.InitParams memory p;
        p.name = "Pass6 Inv-G Drop";
        p.symbol = "P6G";
        p.maxSupply = MAX_SUPPLY;
        p.mintPrice = MINT_PRICE;
        p.maxPerWallet = MAX_PER_WALLET;
        p.royaltyBps = ROYALTY_BPS;
        p.creator = creator;
        p.platformFeeRecipient = platform;
        p.platformFeeBps = PLATFORM_FEE_BPS;
        p.weth = address(weth);
        p.placeholderURI = "ipfs://placeholder";
        p.contractURI_ = "ipfs://collection";
        p.merkleRoot = bytes32(0);
        p.initialPhase = TegridyDropV2.MintPhase.PUBLIC;

        drop.initialize(p);

        // Build actors: 4 minters + the attacker.
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(uint256(keccak256(abi.encode("inv_g_actor", i)))));
            actorsArr.push(a);
            vm.deal(a, 100 ether);
        }
        actorsArr.push(attackerActor);
        vm.deal(attackerActor, 100 ether);

        handler = new InvG_Handler(drop, weth, creator, actorsArr, attackerActor);
        targetContract(address(handler));
    }

    /// @notice INVARIANT G1: totalSupply NEVER exceeds maxSupply.
    function invariant_supplyCapHolds() public view {
        assertLe(
            drop.totalSupply(),
            drop.maxSupply(),
            "INV-G1: totalSupply exceeds maxSupply"
        );
    }

    /// @notice INVARIANT G2: sum(mintedPerWallet[*]) == totalSupply.
    function invariant_walletAccountingMatchesTotal() public view {
        uint256 sum;
        for (uint256 i = 0; i < actorsArr.length; i++) {
            sum += drop.mintedPerWallet(actorsArr[i]);
        }
        assertEq(
            sum,
            drop.totalSupply(),
            "INV-G2: mintedPerWallet sum diverges from totalSupply"
        );
    }

    /// @notice INVARIANT G3: in CANCELLED phase, totalSupply MUST be 0
    ///         (cancellation rule: post-V2-DROP-02 requires totalSupply == 0).
    function invariant_cancelImpliesZeroSupply() public view {
        if (drop.mintPhase() == TegridyDropV2.MintPhase.CANCELLED) {
            assertEq(
                drop.totalSupply(),
                0,
                "INV-G3: cancellation reached with non-zero totalSupply (H18 regression)"
            );
        }
    }

    /// @notice INVARIANT G4: non-owner setMintPhase / cancelSale calls always
    ///         revert. Probed by the handler on every iteration. Counter
    ///         must stay at 0.
    function invariant_phaseChangeAuthHolds() public view {
        assertEq(
            handler.nonOwnerPhaseChangeSucceeded(),
            0,
            "INV-G4a: non-owner setMintPhase succeeded"
        );
        assertEq(
            handler.nonOwnerCancelSucceeded(),
            0,
            "INV-G4b: non-owner cancelSale succeeded"
        );
    }

    /// @notice INVARIANT G5: payment conservation — sum of paidPerWallet
    ///         entries never exceeds totalProceeds. Tracks the H19/V2-DROP-02
    ///         no-double-spend invariant: refunds decrement totalProceeds in
    ///         lockstep with paidPerWallet.
    function invariant_paymentConservation() public view {
        uint256 sumPaid;
        for (uint256 i = 0; i < actorsArr.length; i++) {
            sumPaid += drop.paidPerWallet(actorsArr[i]);
        }
        assertLe(
            sumPaid,
            drop.totalProceeds(),
            "INV-G5: sum(paidPerWallet) > totalProceeds (refund accounting drift)"
        );
    }
}
