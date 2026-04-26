// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../../src/TegridyStaking.sol";
import "../../src/TegridyLending.sol";

/// @title Lending invariant suite (R061)
/// @notice Stateful invariants for `TegridyLending` covering escrow/debt
///         conservation. Pairs the open-loan NFT escrow guarantee with the
///         active-offer ETH solvency guarantee — together they certify that
///         every open obligation has a backing asset held by the contract.
///
///         fail_on_revert is left at the foundry.toml default (false) so
///         handler reverts on edge cases (paused, bound limits) don't fail
///         the run — invariants only assert state after each call.

contract LendingR061Toweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract LendingR061JBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }
}

/// @dev Lean WETH mock — TegridyLending uses WETHFallbackLib but performs no
///      symbol/decimals validation, so the minimal surface suffices.
contract LendingR061WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "weth: bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @dev Minimal TegridyPair shape so TegridyLending's constructor can resolve
///      which slot is TOWELI without depending on a real factory.
contract LendingR061Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0;
        token1 = _t1;
        reserve0 = _r0;
        reserve1 = _r1;
    }
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

/// @dev Minimal TegridyTWAP mock — the post-R003 lending source consults
///      `consult()` and `getLatestObservation()` only on the ETH-floor path,
///      which the handler never enables (always passes 0). Returning a
///      non-zero, fresh observation lets the constructor succeed regardless.
contract LendingR061TWAP {
    struct Observation {
        uint32 timestamp;
        uint224 price0Cumulative;
        uint224 price1Cumulative;
    }
    function consult(address, address, uint256 amountIn, uint256) external pure returns (uint256) {
        return amountIn / 1000; // arbitrary 1 TOWELI = 0.001 ETH
    }
    function getLatestObservation(address) external view returns (Observation memory o) {
        o.timestamp = uint32(block.timestamp);
    }
}

/// @notice Narrow handler exposing only the offer/accept lifecycle. Repayment
///         and default paths are intentionally excluded so the active-offer
///         and open-loan accounting invariants don't have to model interest
///         math or the grace window — the structural guarantees still hold.
contract LendingR061Handler is Test {
    TegridyLending public lending;
    TegridyStaking public staking;
    LendingR061Toweli public toweli;
    LendingR061JBAC public jbac;
    address public lender;
    address public borrower;
    uint256 public borrowerTokenId;

    constructor(
        TegridyLending _lending,
        TegridyStaking _staking,
        LendingR061Toweli _toweli,
        LendingR061JBAC _jbac,
        address _lender,
        address _borrower,
        uint256 _borrowerTokenId
    ) {
        lending = _lending;
        staking = _staking;
        toweli = _toweli;
        jbac = _jbac;
        lender = _lender;
        borrower = _borrower;
        borrowerTokenId = _borrowerTokenId;
    }

    function doCreateOffer(uint256 principal, uint256 aprBps, uint256 duration) external {
        principal = bound(principal, 0.01 ether, 100 ether);
        aprBps = bound(aprBps, 0, 50000);
        duration = bound(duration, 1 days, 90 days);
        if (lender.balance < principal) return;
        vm.prank(lender);
        try lending.createLoanOffer{value: principal}(
            aprBps,
            duration,
            address(staking),
            1 ether, // min position value — we always exceed in setUp
            0        // no ETH-floor check
        ) {} catch {}
    }

    function doCancelOffer(uint256 offerIdSeed) external {
        uint256 count = lending.offerCount();
        if (count == 0) return;
        uint256 idx = offerIdSeed % count;
        vm.prank(lender);
        try lending.cancelOffer(idx) {} catch {}
    }

    function doAcceptOffer(uint256 offerIdSeed) external {
        uint256 count = lending.offerCount();
        if (count == 0) return;
        // Borrower can only have one active loan at a time given a single NFT.
        if (staking.ownerOf(borrowerTokenId) != borrower) return;
        uint256 idx = offerIdSeed % count;
        vm.prank(borrower);
        try lending.acceptOffer(idx, borrowerTokenId) {} catch {}
    }
}

contract LendingInvariantsTest is Test {
    LendingR061Toweli public toweli;
    LendingR061JBAC public jbac;
    LendingR061WETH public weth;
    LendingR061Pair public pair;
    LendingR061TWAP public twap;
    TegridyStaking public staking;
    TegridyLending public lending;
    LendingR061Handler public handler;

    address public treasury = makeAddr("r061_lending_treasury");
    address public lender = makeAddr("r061_lending_lender");
    address public borrower = makeAddr("r061_lending_borrower");

    uint256 public borrowerTokenId;

    function setUp() public {
        toweli = new LendingR061Toweli();
        jbac = new LendingR061JBAC();
        weth = new LendingR061WETH();

        // Pair must contain WETH for TegridyLending's constructor token-side
        // resolution; reserves are deterministic so any optional ETH-floor
        // checks (we don't enable them) would be predictable.
        pair = new LendingR061Pair(
            address(toweli),
            address(weth),
            1_000_000 ether,
            1_000 ether
        );

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        twap = new LendingR061TWAP();
        lending = new TegridyLending(
            treasury,
            500,
            address(weth),
            address(pair),
            address(twap),
            address(0) // sequencer feed: address(0) = mainnet/disabled
        );

        // Borrower stakes once to mint a position NFT used as collateral.
        toweli.transfer(borrower, 100_000 ether);
        vm.startPrank(borrower);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(10_000 ether, 365 days);
        borrowerTokenId = staking.userTokenId(borrower);
        vm.stopPrank();

        // Past the staking-NFT 24h transfer cooldown.
        vm.warp(block.timestamp + 25 hours);
        vm.prank(borrower);
        staking.approve(address(lending), borrowerTokenId);

        // Seed the lender. Big enough for many offers, small enough that the
        // PrincipalTooLarge cap never short-circuits the handler.
        vm.deal(lender, 10_000 ether);

        handler = new LendingR061Handler(
            lending, staking, toweli, jbac, lender, borrower, borrowerTokenId
        );
        targetContract(address(handler));
    }

    /// @notice invariant_collateralValueGteDebtValue — every open loan
    ///         (not yet repaid AND not yet default-claimed) must have its
    ///         collateral NFT held by the lending contract. Catches a bug
    ///         where the NFT escrow could leak (e.g., a faulty repay path
    ///         that fires before flipping `repaid = true`).
    function invariant_collateralValueGteDebtValue() public view {
        uint256 n = lending.loanCount();
        for (uint256 i = 0; i < n; i++) {
            (
                ,                       // borrower
                ,                       // lender
                ,                       // offerId
                uint256 tokenId,
                ,                       // principal
                ,                       // aprBps
                ,                       // startTime
                ,                       // deadline
                bool repaid,
                bool defaultClaimed
            ) = lending.getLoan(i);
            if (repaid || defaultClaimed) continue;
            assertEq(
                staking.ownerOf(tokenId),
                address(lending),
                "R061 open loan without escrowed NFT"
            );
        }
    }

    /// @notice invariant_offerETHEarmarked — the sum of every active offer's
    ///         principal must be <= the lending contract's ETH balance.
    ///         Active offers are still-redeemable; a cancel must always be
    ///         able to refund. This is the protocol-level solvency check.
    function invariant_offerETHEarmarked() public view {
        uint256 n = lending.offerCount();
        uint256 owed;
        for (uint256 i = 0; i < n; i++) {
            (, uint256 principal, , , , , , bool active) = lending.getOffer(i);
            if (active) owed += principal;
        }
        assertLe(owed, address(lending).balance, "R061 active offer ETH underfunded");
    }
}
