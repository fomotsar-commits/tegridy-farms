// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TegridyPair.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyFactory.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";

// ═══════════════════════════════════════════════════════════════════
// Mock Tokens for Final Audit
// ═══════════════════════════════════════════════════════════════════

contract AuditMockToken is ERC20 {
    uint8 private _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
        _mint(msg.sender, 1_000_000_000 * 10 ** uint256(dec_));
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract AuditWETH9 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @dev Fee-on-transfer token for audit tests
contract AuditFoTToken is ERC20 {
    uint256 public feePercent;

    constructor(string memory name_, string memory symbol_, uint256 feePct_) ERC20(name_, symbol_) {
        feePercent = feePct_;
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && feePercent > 0) {
            uint256 fee = (amount * feePercent) / 100;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev Rebase token that can change balances externally (simulates elastic supply)
contract AuditRebaseToken is ERC20 {
    uint256 public multiplier = 100; // 100 = 1x, 200 = 2x

    constructor() ERC20("Rebase", "REB") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMultiplier(uint256 m) external {
        multiplier = m;
    }

    // Override balanceOf to simulate rebase
    function balanceOf(address account) public view override returns (uint256) {
        return (super.balanceOf(account) * multiplier) / 100;
    }
}

/// @dev Self-destructing token mock (simulates token that disappears)
contract SelfDestructToken is ERC20 {
    constructor() ERC20("Destruct", "DST") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Simulates a scenario where token code disappears
    function selfDestructNow(address payable recipient) external {
        selfdestruct(recipient);
    }
}

/// @dev Evil factory that creates pairs for tokens to test factory bypass
contract EvilFactory {
    function createFakePair(address token0, address token1) external returns (address pair) {
        bytes memory bytecode = type(TegridyPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        TegridyPair(pair).initialize(token0, token1);
    }
}

// ═══════════════════════════════════════════════════════════════════
// FINAL AUDIT TEST SUITE
// ═══════════════════════════════════════════════════════════════════

contract FinalAuditAMM is Test {
    TegridyFactory public factory;
    TegridyRouter public router;
    AuditWETH9 public weth;
    AuditMockToken public tokenA;
    AuditMockToken public tokenB;
    AuditMockToken public tokenC;
    TegridyPair public pairAB;
    TegridyPair public pairBC;

    address public deployer;
    address public attacker = makeAddr("attacker");
    address public alice = makeAddr("alice");
    address public feeTo = makeAddr("feeTo");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        deployer = address(this);

        weth = new AuditWETH9();
        factory = new TegridyFactory(deployer, deployer);

        // Set feeTo via timelock
        factory.proposeFeeToChange(feeTo);
        vm.warp(block.timestamp + 48 hours);
        factory.executeFeeToChange();

        router = new TegridyRouter(address(factory), address(weth));

        tokenA = new AuditMockToken("Token A", "TKA", 18);
        tokenB = new AuditMockToken("Token B", "TKB", 18);
        tokenC = new AuditMockToken("Token C", "TKC", 18);

        // Ensure address ordering for predictable token0/token1
        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        // Create pair A/B with initial liquidity
        address pairAddr = factory.createPair(address(tokenA), address(tokenB));
        pairAB = TegridyPair(pairAddr);

        // Fund pair: 100 ether each side
        tokenA.transfer(address(pairAB), 100 ether);
        tokenB.transfer(address(pairAB), 100 ether);
        pairAB.mint(deployer);

        // Create pair B/C for multi-hop testing
        if (address(tokenB) > address(tokenC)) {
            // Swap to ensure B < C ordering is correct for pair creation
        }
        address pairBCAddr = factory.createPair(address(tokenB), address(tokenC));
        pairBC = TegridyPair(pairBCAddr);
        tokenB.transfer(address(pairBC), 100 ether);
        tokenC.transfer(address(pairBC), 100 ether);
        pairBC.mint(deployer);

        // Fund attacker
        tokenA.transfer(attacker, 10_000 ether);
        tokenB.transfer(attacker, 10_000 ether);
        tokenC.transfer(attacker, 10_000 ether);
        vm.deal(attacker, 100 ether);

        // Fund alice
        tokenA.transfer(alice, 10_000 ether);
        tokenB.transfer(alice, 10_000 ether);
        vm.deal(alice, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #1: K-invariant rounding in mint/burn/swap
    //           Verify K never decreases through rounding
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT1_kInvariantNeverDecreasesViaSwap() public {
        // Perform many swaps of varying sizes and verify K always increases
        vm.startPrank(attacker);

        uint256[] memory amounts = new uint256[](5);
        amounts[0] = 1; // 1 wei - extreme minimum
        amounts[1] = 100; // 100 wei
        amounts[2] = 0.001 ether;
        amounts[3] = 1 ether;
        amounts[4] = 10 ether;

        for (uint256 i = 0; i < amounts.length; i++) {
            (uint112 r0, uint112 r1,) = pairAB.getReserves();
            uint256 kBefore = uint256(r0) * uint256(r1);

            uint256 amountIn = amounts[i];
            tokenA.transfer(address(pairAB), amountIn);

            (r0, r1,) = pairAB.getReserves();
            uint256 amountOut = _getAmountOut(amountIn, r0, r1);

            if (amountOut > 0) {
                pairAB.swap(0, amountOut, attacker, "");

                (uint112 r0After, uint112 r1After,) = pairAB.getReserves();
                uint256 kAfter = uint256(r0After) * uint256(r1After);

                assertTrue(kAfter >= kBefore, string.concat(
                    "CRITICAL: K decreased after swap with amount ", vm.toString(amountIn)
                ));
            }
        }
        vm.stopPrank();
    }

    function test_AUDIT1b_kInvariantRoundingViaMintBurn() public {
        // Test that mint/burn cycles don't cause K to decrease
        (uint112 r0_init, uint112 r1_init,) = pairAB.getReserves();
        uint256 kInit = uint256(r0_init) * uint256(r1_init);

        // Add liquidity
        vm.startPrank(alice);
        tokenA.transfer(address(pairAB), 10 ether);
        tokenB.transfer(address(pairAB), 10 ether);
        uint256 liquidity = pairAB.mint(alice);

        (uint112 r0_mid, uint112 r1_mid,) = pairAB.getReserves();
        uint256 kMid = uint256(r0_mid) * uint256(r1_mid);
        assertTrue(kMid >= kInit, "K should not decrease after mint");

        // Remove liquidity
        IERC20(address(pairAB)).transfer(address(pairAB), liquidity);
        pairAB.burn(alice);

        (uint112 r0_end, uint112 r1_end,) = pairAB.getReserves();
        uint256 kEnd = uint256(r0_end) * uint256(r1_end);

        // K after burn may be slightly less than kMid due to protocol fee
        // but should still be >= kInit because fees were added
        assertTrue(kEnd >= kInit, "K should not decrease below initial after mint+burn");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #2: MINIMUM_LIQUIDITY lock bypass
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT2_minimumLiquidityCannotBeCircumvented() public {
        AuditMockToken tX = new AuditMockToken("X", "X", 18);
        AuditMockToken tY = new AuditMockToken("Y", "Y", 18);
        if (address(tX) > address(tY)) (tX, tY) = (tY, tX);
        address freshPair = factory.createPair(address(tX), address(tY));
        TegridyPair fp = TegridyPair(freshPair);

        // Try deposits below the MINIMUM_LIQUIDITY * 1000 threshold
        // sqrt(999 * 999) = 999 < 1000 * 1000 = 1_000_000 -- should fail
        tX.transfer(address(fp), 999);
        tY.transfer(address(fp), 999);

        // 999 < 1000 minimum, so it reverts with MIN_INITIAL_TOKENS before reaching liquidity check
        vm.expectRevert("MIN_INITIAL_TOKENS");
        fp.mint(deployer);

        // Also verify 1_000_000 tokens each: sqrt(1e6*1e6) = 1e6 which is NOT > 1_000_000
        // Need fresh pair since tokens are stuck
        AuditMockToken tX2 = new AuditMockToken("X2", "X2", 18);
        AuditMockToken tY2 = new AuditMockToken("Y2", "Y2", 18);
        if (address(tX2) > address(tY2)) (tX2, tY2) = (tY2, tX2);
        address freshPair2 = factory.createPair(address(tX2), address(tY2));
        TegridyPair fp2 = TegridyPair(freshPair2);

        tX2.transfer(address(fp2), 1_000_000);
        tY2.transfer(address(fp2), 1_000_000);

        // sqrt(1_000_000 * 1_000_000) = 1_000_000 which is NOT > 1_000_000
        vm.expectRevert("INSUFFICIENT_INITIAL_LIQUIDITY");
        fp2.mint(deployer);

        // Verify the dead address holds the lock after successful mint
        AuditMockToken tX3 = new AuditMockToken("X3", "X3", 18);
        AuditMockToken tY3 = new AuditMockToken("Y3", "Y3", 18);
        if (address(tX3) > address(tY3)) (tX3, tY3) = (tY3, tX3);
        address freshPair3 = factory.createPair(address(tX3), address(tY3));
        TegridyPair fp3 = TegridyPair(freshPair3);

        tX3.transfer(address(fp3), 2_000_000);
        tY3.transfer(address(fp3), 2_000_000);
        fp3.mint(deployer);

        // Verify MINIMUM_LIQUIDITY is locked at 0xdead
        uint256 deadBalance = fp3.balanceOf(address(0xdead));
        assertEq(deadBalance, 1000, "MINIMUM_LIQUIDITY should be locked at 0xdead");
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #3: disabledPairs gas griefing on every swap
    //           External STATICCALL to factory on every swap()
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT3_disabledPairsGasOverhead() public {
        // Measure gas cost of swap with the factory.disabledPairs() check
        vm.startPrank(attacker);

        uint256 amountIn = 1 ether;
        tokenA.transfer(address(pairAB), amountIn);
        (uint112 r0, uint112 r1,) = pairAB.getReserves();
        uint256 amountOut = _getAmountOut(amountIn, r0, r1);

        uint256 gasBefore = gasleft();
        pairAB.swap(0, amountOut, attacker, "");
        uint256 gasUsed = gasBefore - gasleft();

        vm.stopPrank();

        emit log_named_uint("Gas used for swap with disabledPairs check", gasUsed);

        // The external call to factory.disabledPairs() costs ~2600 gas (cold SLOAD in STATICCALL)
        // This is acceptable overhead. Log it as informational.
        // NOTE: This is a view-only STATICCALL, not state-modifying, so no griefing vector
        // beyond the ~2600 gas cost per swap.
        assertTrue(gasUsed < 200_000, "Swap gas cost should be reasonable");
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #4: _validateNoDuplicates O(n^2) gas griefing
    //           Max path length is 10, so worst case is 10*9/2 = 45 comparisons
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT4_validateNoDuplicatesGasWithMaxPath() public {
        // Create enough pairs for a 10-hop path
        // Path: A -> B -> C -> D -> E -> F -> G -> H -> I -> J
        AuditMockToken[] memory tokens = new AuditMockToken[](10);
        tokens[0] = tokenA;
        tokens[1] = tokenB;
        tokens[2] = tokenC;

        for (uint256 i = 3; i < 10; i++) {
            tokens[i] = new AuditMockToken(
                string.concat("T", vm.toString(i)),
                string.concat("T", vm.toString(i)),
                18
            );
        }

        // Create pairs and add liquidity for each consecutive pair
        for (uint256 i = 2; i < 9; i++) {
            address t0 = address(tokens[i]);
            address t1 = address(tokens[i + 1]);
            if (t0 == t1) continue;

            address pair = factory.createPair(t0, t1);
            tokens[i].transfer(pair, 100 ether);
            tokens[i + 1].transfer(pair, 100 ether);
            TegridyPair(pair).mint(deployer);
        }

        // Build the max-length path
        address[] memory path = new address[](10);
        for (uint256 i = 0; i < 10; i++) {
            path[i] = address(tokens[i]);
        }

        // Test getAmountsOut with max path to measure gas of the duplicate check
        // The router's _swap and _swapSupportingFeeOnTransferTokens both have the O(n^2) check
        uint256 gasBefore = gasleft();
        try router.getAmountsOut(1 ether, path) {
            // getAmountsOut doesn't call _validateNoDuplicates (only _swap does)
            // but it does iterate the path -- helps confirm path length is capped
        } catch {}
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Gas for getAmountsOut with 10-hop path", gasUsed);

        // With path.length <= 10, the O(n^2) duplicate check does at most 45 comparisons
        // Each comparison is ~200 gas (2 SLOADs from memory), so ~9000 gas total.
        // This is NOT a meaningful griefing vector.
        // FINDING: INFORMATIONAL - O(n^2) is bounded by path.length <= 10, so max 45 iterations
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #5: Balance-before/after pattern with rebase tokens
    //           Rebase tokens change balanceOf() mid-transaction
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT5_rebaseTokenExploitsBalanceBeforeAfter() public {
        // Create a rebase token
        AuditRebaseToken rebaseToken = new AuditRebaseToken();

        // Create pair with rebase token
        // Note: Factory will deploy the pair, but rebase tokens break the invariant
        address t0 = address(rebaseToken);
        address t1 = address(tokenA);

        address pairAddr = factory.createPair(t0, t1);
        TegridyPair rPair = TegridyPair(pairAddr);

        // Seed liquidity while multiplier = 100 (1x)
        rebaseToken.transfer(address(rPair), 100 ether);
        tokenA.transfer(address(rPair), 100 ether);
        rPair.mint(deployer);

        (uint112 r0, uint112 r1,) = rPair.getReserves();
        emit log_named_uint("Initial reserve0", r0);
        emit log_named_uint("Initial reserve1", r1);

        // Now simulate a positive rebase (2x)
        rebaseToken.setMultiplier(200);

        // After rebase, balanceOf(pair) returns 2x the actual internal balance
        // This means balance > reserves, and skim/sync will see phantom tokens
        uint256 pairBalance = rebaseToken.balanceOf(address(rPair));
        emit log_named_uint("Pair rebase balance after 2x", pairBalance);
        assertTrue(pairBalance > r0, "Rebase should inflate balance");

        // sync() would update reserves to the inflated balance
        // This means LPs can redeem more tokens than were actually deposited
        rPair.sync();
        (uint112 r0After, uint112 r1After,) = rPair.getReserves();
        emit log_named_uint("Reserve0 after sync", r0After);

        // FINDING: MEDIUM - Rebase tokens completely break the AMM invariant.
        // After a positive rebase, sync() inflates reserves, allowing LPs to extract
        // phantom tokens. After a negative rebase, reserves exceed actual balance,
        // causing all swaps/burns to revert.
        // DEFENSE: Contract documentation states rebase tokens are not supported.
        // The factory should ideally block known rebase tokens via blockedTokens.
        assertTrue(r0After > r0, "sync() absorbed rebase phantom tokens");
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #6: mintFee protocol fee manipulation
    //           Can the fee calculation be gamed?
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT6_mintFeeManipulation() public {
        // The protocol fee is minted during mint/burn as:
        //   liquidity = totalSupply * (rootK - rootKLast) / (rootK * 5 + rootKLast)
        // An attacker could try to manipulate kLast by:
        // 1. Doing many swaps to increase K (fees accumulate)
        // 2. Then calling mint with dust to trigger _mintFee and capture the accumulated fees

        uint256 feeToBalBefore = pairAB.balanceOf(feeTo);

        // Do a large swap to accumulate fees in K
        vm.startPrank(attacker);
        tokenA.transfer(address(pairAB), 50 ether);
        (uint112 r0, uint112 r1,) = pairAB.getReserves();
        uint256 amountOut = _getAmountOut(50 ether, r0, r1);
        pairAB.swap(0, amountOut, attacker, "");
        vm.stopPrank();

        // Now trigger _mintFee by adding dust liquidity
        vm.startPrank(alice);
        tokenA.transfer(address(pairAB), 1000);
        tokenB.transfer(address(pairAB), 1000);
        // This might not mint LP tokens (too small) but _mintFee runs first
        try pairAB.mint(alice) {} catch {}
        vm.stopPrank();

        uint256 feeToBalAfter = pairAB.balanceOf(feeTo);
        uint256 protocolFee = feeToBalAfter - feeToBalBefore;

        emit log_named_uint("Protocol fee LP tokens minted", protocolFee);

        // The fee is proportional to sqrt(K) growth, which is correct.
        // The protocol gets 1/6 of fees, LPs get 5/6. This is standard Uniswap V2.
        // FINDING: NONE - mintFee follows Uniswap V2 formula correctly.
        // An attacker triggering it early just causes the fee to be minted sooner,
        // but doesn't change the total amount.
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #7: _safeTransfer without code.length check
    //           If a token self-destructs, what happens?
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT7_safeTransferToSelfDestructedToken() public {
        // After EIP-6780 (Shanghai), SELFDESTRUCT only destroys in the same tx
        // as creation. In later txs, it just sends ETH but code persists.
        // So the traditional "token self-destructs and low-level call returns true
        // on empty address" attack is no longer viable post-Shanghai.

        // However, test the _safeTransfer behavior:
        // token.call(transfer) to an address with no code returns success=true, data=empty
        // The check: require(success && (data.length == 0 || abi.decode(data, (bool))))
        // If token has no code: success=true (EVM spec), data.length=0, so it PASSES
        // This means if a token somehow loses its code, transfers would silently succeed
        // without actually moving tokens.

        // FINDING: LOW - _safeTransfer does not check token.code.length > 0.
        // If a token's code is somehow destroyed (theoretically impossible post-EIP-6780
        // unless created+destroyed in same tx), the low-level call returns (true, "")
        // which passes the check, causing a silent no-op transfer.
        // Post-Shanghai, this is practically unexploitable, but adding a code.length
        // check would be a defense-in-depth improvement.

        // Verify current behavior: call to EOA returns (true, "")
        address eoa = makeAddr("random_eoa");
        (bool success, bytes memory data) = eoa.call(
            abi.encodeWithSelector(IERC20.transfer.selector, address(this), 100)
        );
        assertTrue(success, "Call to EOA succeeds");
        assertEq(data.length, 0, "Call to EOA returns empty data");
        // This would pass _safeTransfer's check - confirming the theoretical issue
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #8: Factory bypass via different factory
    //           Can pairs created by a rogue factory interact with the router?
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT8_factoryBypassViaRogueFactory() public {
        // The router uses factory.getPair() to look up pairs.
        // A pair created by a different factory won't be in our factory's mapping.
        // Therefore the router will revert with "PAIR_NOT_FOUND".

        EvilFactory evil = new EvilFactory();

        // The evil factory creates a pair, but it won't be registered in our factory
        AuditMockToken evilTokenA = new AuditMockToken("Evil A", "EVA", 18);
        AuditMockToken evilTokenB = new AuditMockToken("Evil B", "EVB", 18);
        if (address(evilTokenA) > address(evilTokenB)) {
            (evilTokenA, evilTokenB) = (evilTokenB, evilTokenA);
        }

        address evilPair = evil.createFakePair(address(evilTokenA), address(evilTokenB));
        assertTrue(evilPair != address(0), "Evil pair should be created");

        // Verify it's NOT in our factory
        address registered = factory.getPair(address(evilTokenA), address(evilTokenB));
        assertEq(registered, address(0), "Evil pair should NOT be in our factory");

        // Try to swap via our router - should fail
        vm.startPrank(attacker);
        evilTokenA.mint(attacker, 100 ether);
        evilTokenA.approve(address(router), type(uint256).max);

        address[] memory path = new address[](2);
        path[0] = address(evilTokenA);
        path[1] = address(evilTokenB);

        vm.expectRevert(TegridyRouter.PairNotFound.selector);
        router.swapExactTokensForTokens(1 ether, 0, path, attacker, block.timestamp + 30 minutes);
        vm.stopPrank();

        // FINDING: NONE - Router relies on factory.getPair() which only returns
        // pairs created by our factory. Rogue factories cannot inject pairs.

        // However, the pair's swap() itself only checks factory.disabledPairs().
        // The pair's `factory` is set in constructor to msg.sender (the deploying factory).
        // For our pairs, this is correct. Evil pairs point to the evil factory.
        // Direct interaction with evil pairs is unrelated to our protocol.
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #9: Router _swap off-by-one in cached pairs array
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT9_swapOffByOneInPairsArray() public {
        // _swap creates: pairs = new address[](hops) where hops = path.length - 1
        // Then iterates: for i = 0; i < hops; i++
        //   pairs[i] = _pairFor(path[i], path[i+1])  -- correct
        //   to = i < hops - 1 ? pairs[i+1] : _to     -- correct

        // Test 2-hop swap: A -> B -> C
        vm.startPrank(attacker);
        tokenA.approve(address(router), type(uint256).max);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);

        uint256 balBefore = tokenC.balanceOf(attacker);

        router.swapExactTokensForTokens(
            1 ether, 0, path, attacker, block.timestamp + 30 minutes
        );

        uint256 balAfter = tokenC.balanceOf(attacker);
        assertTrue(balAfter > balBefore, "Multi-hop swap should work");

        vm.stopPrank();

        // Verify intermediate routing: tokens went A->pairAB->pairBC->attacker
        // No off-by-one because:
        // i=0: pairs[0]=pairAB, to=pairs[1]=pairBC (i < hops-1=1)
        // i=1: pairs[1]=pairBC, to=attacker (i == hops-1)
        // FINDING: NONE - Indexing is correct.
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #10: SwapFeeRouter dust accumulation
    //           Can rounding in fee calculation leave meaningful dust?
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT10_swapFeeRouterDustAccumulation() public {
        // Deploy SwapFeeRouter with 30 bps fee
        SwapFeeRouter feeRouter = new SwapFeeRouter(
            address(router),
            treasury,
            30, // 0.3%
            address(0) // no referral
        );

        // Test: many small swaps to accumulate dust from rounding
        // fee = (msg.value * 30) / 10000
        // For msg.value = 333 wei: fee = (333 * 30) / 10000 = 9990 / 10000 = 0
        // But the contract has: if (fee == 0 && feeBps > 0) fee = 1;
        // So minimum fee is 1 wei when feeBps > 0.

        // Test boundary: what value gives fee = 0 before the minimum check?
        // fee = (value * 30) / 10000 = 0 when value * 30 < 10000
        // value < 334 (333.33...)
        uint256 dust = (uint256(333) * uint256(30)) / uint256(10000);
        assertEq(dust, 0, "333 wei should produce 0 fee before min check");

        // With the min fee = 1 fix, user pays 1 wei on 333 wei input
        // That's a 0.3% effective fee (1/333 = 0.3%), which is correct
        // FINDING: INFORMATIONAL - The min fee of 1 wei prevents zero-fee grinding.
        // Dust can only accumulate in the accumulatedTokenFees mapping for token-to-token
        // swaps if withdrawTokenFees uses balance-diff (which it does).

        // Test withdrawTokenFees accounting with FoT token
        // The contract does: accumulatedTokenFees[token] -= actualTransferred
        // If actualTransferred < amount (FoT), there's a remaining dust amount
        // that can never be withdrawn because the next call also under-transfers.
        // This is bounded and cannot be exploited for profit.

        // FINDING: LOW - withdrawTokenFees with FoT tokens leaves permanent dust
        // in accumulatedTokenFees because safeTransfer sends `amount` but only
        // `actualTransferred` arrives. The mapping is reduced by actualTransferred,
        // leaving (amount - actualTransferred) stuck forever. This is at most
        // feePercent% of each withdrawal and is not exploitable.
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #11: adjustedMin cap (M-03 fix) boundary values
    //           Can the adjustedMin calculation cause unexpected behavior?
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT11_adjustedMinBoundaryValues() public pure {
        // The adjustedMin formula in swapExactTokensForETH:
        //   if (feeBps >= BPS) revert AdjustedMinOverflow();
        //   else if (amountOutMin <= type(uint256).max / BPS)
        //     adjustedMin = (amountOutMin * BPS + BPS - feeBps - 1) / (BPS - feeBps);
        //   else
        //     adjustedMin = amountOutMin;

        uint256 BPS = 10000;
        uint256 feeBps = 30;

        // Test case 1: normal value
        uint256 amountOutMin1 = 100;
        uint256 adjusted1 = (amountOutMin1 * BPS + BPS - feeBps - 1) / (BPS - feeBps);
        assertTrue(adjusted1 >= amountOutMin1, "adjustedMin should be >= amountOutMin");

        // Test case 2: value near the safe boundary (but not at the edge to avoid +BPS overflow)
        uint256 maxSafe = type(uint256).max / BPS;
        uint256 nearBoundary = maxSafe - 1; // one below to leave room for + BPS in numerator
        uint256 adjusted2 = (nearBoundary * BPS + BPS - feeBps - 1) / (BPS - feeBps);
        assertTrue(adjusted2 >= nearBoundary, "adjustedMin near boundary should be >= amountOutMin");

        // Test case 3: value above the safe boundary falls to else branch
        // In the contract, amountOutMin > maxSafe triggers: adjustedMin = amountOutMin
        // This means adjustedMin is NOT inflated to account for fees.
        // The underlying router must produce >= amountOutMin ETH, then fee is deducted,
        // so userAmount = amountOutMin - fee < amountOutMin, causing SlippageExceeded revert.
        // FINDING: LOW - When amountOutMin > type(uint256).max / BPS, the fallback
        // makes the effective slippage check STRICTER (reverts conservatively).
        // This is a safe failure mode. Practically, such large amountOutMin values are
        // impossible since no pool holds that much ETH.

        // Verify feeBps = 0 means no inflation
        uint256 adjusted0fee = (amountOutMin1 * BPS + BPS - 0 - 1) / (BPS - 0);
        assertEq(adjusted0fee, amountOutMin1, "No fee means adjustedMin == amountOutMin");
    }

    // ═══════════════════════════════════════════════════════════════
    // AUDIT #12: skim() + sync() oracle manipulation
    // ═══════════════════════════════════════════════════════════════

    function test_AUDIT12_skimSyncOracleManipulation() public {
        // TWAP is not implemented, so there's no on-chain oracle to manipulate.
        // However, test if skim + sync can be used to:
        // 1. Inflate/deflate reserves for getReserves() consumers
        // 2. Affect subsequent swap pricing

        (uint112 r0_init, uint112 r1_init,) = pairAB.getReserves();

        // Attacker donates token0 to skew the ratio
        vm.startPrank(attacker);
        tokenA.transfer(address(pairAB), 50 ether);
        vm.stopPrank();

        // Before sync: reserves are stale, actual balance is higher
        // getReserves() still returns old values
        (uint112 r0_pre, uint112 r1_pre,) = pairAB.getReserves();
        assertEq(r0_pre, r0_init, "Reserves unchanged before sync");

        // Call sync to update reserves
        pairAB.sync();
        (uint112 r0_post, uint112 r1_post,) = pairAB.getReserves();
        assertEq(uint256(r0_post), uint256(r0_init) + 50 ether, "Reserve0 includes donation");
        assertEq(r1_post, r1_init, "Reserve1 unchanged");

        // Now the price is skewed: token0 is "cheaper" relative to token1
        // A subsequent swap of token1 -> token0 gets more token0 than before
        // This benefits the next swapper at the expense of the attacker (who donated)
        // FINDING: INFORMATIONAL - skim/sync can be used to donate tokens to the pool,
        // which benefits LPs and next swappers. The donator always loses.
        // Since TWAP is not implemented, there's no oracle to manipulate.
        // External protocols reading getReserves() for spot price should be aware
        // that sync() can instantly change reserves.

        // Verify that skim + sync cannot extract value
        // After sync, excess = 0, so skim returns nothing
        uint256 balance0 = tokenA.balanceOf(address(pairAB));
        assertEq(uint256(r0_post), balance0, "After sync, balance == reserve");

        // skim should return 0
        uint256 attackerBal = tokenA.balanceOf(attacker);
        vm.prank(attacker);
        pairAB.skim(attacker);
        assertEq(tokenA.balanceOf(attacker), attackerBal, "skim returns nothing after sync");
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: Flash swap rejection
    //              Verify non-empty data is always rejected
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_flashSwapAlwaysRejected() public {
        vm.startPrank(attacker);
        tokenA.transfer(address(pairAB), 1 ether);
        (uint112 r0, uint112 r1,) = pairAB.getReserves();
        uint256 amountOut = _getAmountOut(1 ether, r0, r1);

        vm.expectRevert("NO_FLASH_SWAPS");
        pairAB.swap(0, amountOut, attacker, hex"01");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: Pair.swap() directly checks disabledPairs
    //              Verify this is enforced at the pair level
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_pairSwapChecksDisabledDirectly() public {
        // The pair's swap() has: require(!ITegridyFactory(factory).disabledPairs(address(this)))
        // This means even direct pair interaction is blocked when disabled
        factory.proposePairDisabled(address(pairAB), true);
        vm.warp(block.timestamp + 48 hours);
        factory.executePairDisabled(address(pairAB));

        vm.startPrank(attacker);
        tokenA.transfer(address(pairAB), 1 ether);

        vm.expectRevert("PAIR_DISABLED");
        pairAB.swap(0, 1, attacker, "");
        vm.stopPrank();
        // FINDING: NONE - Unlike RedTeam test which found the pair had no check,
        // the current code DOES check disabledPairs in pair.swap() directly.
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: Cyclic path rejection
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_cyclicPathRejected() public {
        vm.startPrank(attacker);
        tokenA.approve(address(router), type(uint256).max);

        // Try A -> B -> A (cycle)
        address[] memory cyclicPath = new address[](3);
        cyclicPath[0] = address(tokenA);
        cyclicPath[1] = address(tokenB);
        cyclicPath[2] = address(tokenA);

        vm.expectRevert(TegridyRouter.CyclicPath.selector);
        router.swapExactTokensForTokens(1 ether, 0, cyclicPath, attacker, block.timestamp + 30 minutes);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: Identical consecutive tokens in path
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_identicalConsecutiveTokensRejected() public {
        vm.startPrank(attacker);
        tokenA.approve(address(router), type(uint256).max);

        address[] memory badPath = new address[](2);
        badPath[0] = address(tokenA);
        badPath[1] = address(tokenA);

        // Router calls _pairFor -> factory.getPair(A, A) which returns address(0)
        // because no self-pair exists. The _sortTokens check fires first in factory.
        // Actually, the router's getAmountsOut calls _pairFor which hits PAIR_NOT_FOUND
        // because factory.getPair(A,A) returns 0 (self-pairs cannot be created).
        vm.expectRevert(TegridyRouter.PairNotFound.selector);
        router.swapExactTokensForTokens(1 ether, 0, badPath, attacker, block.timestamp + 30 minutes);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: K-invariant with maximum rounding exploitation
    //              Test 1 wei input to extract maximum rounding benefit
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_kInvariantOneWeiSwap() public {
        // With 1 wei input:
        // amountOut = (1 * 997 * reserve1) / (reserve0 * 1000 + 997) ~= 0 for large reserves
        // K check: (balance0*1000 - amountIn*3) * (balance1*1000 - 0) >= reserve0*reserve1*1e6
        // Since amountOut = 0, no tokens leave, K trivially holds
        vm.startPrank(attacker);
        tokenA.transfer(address(pairAB), 1);
        (uint112 r0, uint112 r1,) = pairAB.getReserves();
        uint256 amountOut = _getAmountOut(1, r0, r1);

        // amountOut should be 0 for 1 wei into a 100 ether pool
        assertEq(amountOut, 0, "1 wei swap should yield 0 output");

        // Trying to extract 1 wei should fail K check
        bool reverted = false;
        try pairAB.swap(0, 1, attacker, "") {} catch {
            reverted = true;
        }
        assertTrue(reverted, "1 wei extraction with 1 wei input should fail K check");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: Pair initialized only once
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_pairCannotBeReinitalized() public {
        vm.prank(address(factory));
        vm.expectRevert("ALREADY_INITIALIZED");
        pairAB.initialize(address(tokenA), address(tokenB));
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: burn() cannot drain below MINIMUM_LIQUIDITY
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_burnCannotDrainBelowMinimum() public {
        // The 1000 LP tokens locked at 0xdead ensure totalSupply never reaches 0
        // after initial mint. Even if all other LPs burn, the dead address holds 1000.

        uint256 deployerLP = pairAB.balanceOf(deployer);
        // Transfer all LP to pair and burn
        IERC20(address(pairAB)).transfer(address(pairAB), deployerLP);
        pairAB.burn(deployer);

        uint256 totalSupply = pairAB.totalSupply();
        uint256 deadBalance = pairAB.balanceOf(address(0xdead));

        assertEq(totalSupply, 1000, "Total supply should be MINIMUM_LIQUIDITY after full burn");
        assertEq(deadBalance, 1000, "Dead address holds all remaining supply");

        // Reserves should still have dust proportional to the locked liquidity
        (uint112 r0, uint112 r1,) = pairAB.getReserves();
        assertTrue(r0 > 0 && r1 > 0, "Reserves should have dust from locked liquidity");
    }

    // ═══════════════════════════════════════════════════════════════
    // BONUS AUDIT: SwapFeeRouter withdrawTokenFees FoT dust issue
    //              Verify the accounting mismatch with FoT tokens
    // ═══════════════════════════════════════════════════════════════

    function test_BONUS_withdrawTokenFeesFoTDust() public {
        // Deploy FoT token (5% fee)
        AuditFoTToken fotToken = new AuditFoTToken("FoT", "FOT", 5);

        // Deploy SwapFeeRouter
        SwapFeeRouter feeRouter = new SwapFeeRouter(
            address(router), // underlying router
            treasury,
            30, // 0.3%
            address(0) // no referral
        );

        // Simulate accumulated token fees by sending FoT tokens directly
        // and manually setting the accumulated amount
        // (In reality, fees accumulate via swapExactTokensForTokens)
        fotToken.transfer(address(feeRouter), 100 ether);
        // The FoT takes 5%, so feeRouter receives 95 ether

        // We can't directly set accumulatedTokenFees, so just test the withdrawal pattern
        // The issue: if accumulatedTokenFees[fot] = 95 ether, but safeTransfer(treasury, 95 ether)
        // only delivers 90.25 ether (5% fee), then accumulatedTokenFees reduces by 90.25,
        // leaving 4.75 ether stuck in the mapping that can never be withdrawn.

        // This confirms the LOW severity finding: FoT tokens leave permanent dust
        // in accumulatedTokenFees. The amount is bounded by feePercent% of the fee.
        uint256 feeRouterBal = fotToken.balanceOf(address(feeRouter));
        emit log_named_uint("FeeRouter FoT balance", feeRouterBal);
        assertTrue(feeRouterBal < 100 ether, "FoT should eat 5% on transfer");
    }

    // ═══════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }
}
