// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

interface IERC20Min {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IRouterDeepen {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IFactoryDeepen {
    function getPair(address a, address b) external view returns (address);
}

interface IPairDeepen {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function balanceOf(address a) external view returns (uint256);
}

/// @title  DeepenLP — add proportional liquidity to the ALREADY-SEEDED TOWELI/WETH pool.
/// @notice `SeedLP.s.sol` is first-add only (it aborts on a seeded pool). This
///         script ADDS to the existing pool at the current ratio via the canonical
///         `Router.addLiquidityETH`, to lift the pool above a target reserve depth
///         (e.g. the TWAP's reserve floor so the oracle can bootstrap).
///
/// @dev    The router computes the optimal split to preserve the current price:
///         provide `TOWELI_AMOUNT` + `ETH_AMOUNT` a hair ABOVE the proportional ETH
///         (the script logs the proportional). Excess ETH is refunded. Because the
///         add is proportional, the price does NOT move — the POST-check asserts that.
///         **Submit via a Flashbots-Protect/private RPC** so the add can't be sandwiched.
///
/// @dev    Env vars:
///           TOWELI, ROUTER, TO (LP recipient), TOWELI_AMOUNT (wei), ETH_AMOUNT (wei),
///           SLIPPAGE_BPS (optional, default 100 = 1%), DEADLINE_MINUTES (optional, 20)
///
/// @dev    Run from the wallet holding the TOWELI + ETH (dry-run first):
///           forge script script/DeepenLP.s.sol --rpc-url $FLASHBOTS_RPC --sender $WALLET -vvv
///           forge script script/DeepenLP.s.sol --rpc-url $FLASHBOTS_RPC --broadcast --private-key $KEY -vvv
contract DeepenLP is Script {
    uint256 constant BPS = 10_000;

    function run() external {
        address toweli = vm.envAddress("TOWELI");
        address router = vm.envAddress("ROUTER");
        address to = vm.envAddress("TO");
        uint256 toweliAmount = vm.envUint("TOWELI_AMOUNT");
        uint256 ethAmount = vm.envUint("ETH_AMOUNT");
        uint256 slippageBps = vm.envOr("SLIPPAGE_BPS", uint256(100));
        uint256 deadlineMin = vm.envOr("DEADLINE_MINUTES", uint256(20));

        require(toweli != address(0) && router != address(0) && to != address(0), "TOWELI/ROUTER/TO required");
        require(toweliAmount > 0 && ethAmount > 0, "amounts must be > 0");
        require(slippageBps <= 1000, "SLIPPAGE_BPS too high (>10%)");

        address weth = IRouterDeepen(router).WETH();
        address factory = IRouterDeepen(router).factory();
        address pair = IFactoryDeepen(factory).getPair(toweli, weth);
        require(pair != address(0), "pair does not exist - use SeedLP.s.sol for the first seed");

        (uint112 r0, uint112 r1,) = IPairDeepen(pair).getReserves();
        require(r0 > 0 && r1 > 0, "pool is empty - use SeedLP.s.sol for the first seed");
        address t0 = IPairDeepen(pair).token0();
        (uint256 resToweli, uint256 resWeth) = t0 == toweli ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        // Proportional ETH the router will consume for `toweliAmount` at the current ratio.
        uint256 ethNeeded = (toweliAmount * resWeth) / resToweli;

        console.log("=== DeepenLP plan ===");
        console.log("Pair:", pair);
        console.log("Current reserves TOWELI / WETH:", resToweli, resWeth);
        console.log("Adding TOWELI:", toweliAmount);
        console.log("Proportional ETH needed (wei):", ethNeeded);
        console.log("ETH_AMOUNT provided (wei):", ethAmount);
        console.log("Price (TOWELI per 1 ETH):", (resToweli * 1e18) / resWeth);

        require(IERC20Min(toweli).balanceOf(msg.sender) >= toweliAmount, "sender TOWELI < TOWELI_AMOUNT");
        require(msg.sender.balance >= ethAmount, "sender ETH < ETH_AMOUNT");
        // Provide at least the proportional ETH (minus slippage) or the router caps the TOWELI actually added.
        require(
            ethAmount >= (ethNeeded * (BPS - slippageBps)) / BPS,
            "ETH_AMOUNT below proportional - would cap TOWELI added"
        );

        uint256 tokenMin = (toweliAmount * (BPS - slippageBps)) / BPS;
        uint256 ethMin = (ethNeeded * (BPS - slippageBps)) / BPS;
        uint256 lpBefore = IPairDeepen(pair).balanceOf(to);

        vm.startBroadcast();
        IERC20Min(toweli).approve(router, 0);
        IERC20Min(toweli).approve(router, toweliAmount);
        (uint256 usedToken, uint256 usedEth, uint256 liquidity) = IRouterDeepen(router)
        .addLiquidityETH{value: ethAmount}(
            toweli, toweliAmount, tokenMin, ethMin, to, block.timestamp + deadlineMin * 60
        );
        vm.stopBroadcast();

        // POST: LP minted to `to`, and the price is unchanged (proportional add).
        require(IPairDeepen(pair).balanceOf(to) > lpBefore, "POST: LP balance did not increase");
        (uint112 n0, uint112 n1,) = IPairDeepen(pair).getReserves();
        (uint256 newToweli, uint256 newWeth) = t0 == toweli ? (uint256(n0), uint256(n1)) : (uint256(n1), uint256(n0));
        uint256 oldPrice = (resToweli * 1e18) / resWeth;
        uint256 newPrice = (newToweli * 1e18) / newWeth;
        uint256 diff = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
        require(diff * BPS <= oldPrice * slippageBps, "POST: price moved beyond tolerance");

        console.log("");
        console.log("=== Deepen complete ===");
        console.log("TOWELI added / ETH added:", usedToken, usedEth);
        console.log("LP minted:", liquidity);
        console.log("New reserves TOWELI / WETH:", newToweli, newWeth);
        console.log("NEXT: if WETH side now clears the TWAP floor, run BootstrapTWAP.s.sol 4x.");
    }
}
