// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @dev Minimal surfaces — we don't import the concrete contracts so this script
///      stays replayable against any deploy and never drags the full source graph
///      into the go-live tooling (mirrors TransferOwnershipToMultisig.s.sol).
interface IERC20Min {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function allowance(address o, address s) external view returns (uint256);
}

interface IRouterSeed {
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

interface IFactorySeed {
    function getPair(address a, address b) external view returns (address);
}

interface IPairSeed {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function totalSupply() external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
    function skim(address to) external;
}

/// @title  SeedLP — one-shot initial-liquidity seed for the TOWELI/WETH pool.
/// @notice Seeds the FIRST liquidity into the native TOWELI/WETH pair via the
///         canonical `Router.addLiquidityETH` (Uniswap-V2-Router02 pattern; the
///         H2 atomic create-or-find already closes the first-mint front-run).
///
/// @dev    THREAT — first-add donation grief (audit M7): the pair address is
///         CREATE2-deterministic, so an attacker can force-send tokens to it
///         BEFORE the seed to skew the initial price the TWAP will bootstrap
///         from. Two defenses here:
///           1. If the pair already exists with donated (non-reserve) balances,
///              `skim()` them to the broadcaster first.
///           2. A POST-seed price-conservation assert — the achieved reserves
///              MUST match the intended ratio within SLIPPAGE_BPS, else revert.
///              Any donation that slipped in (public-mempool race) trips this and
///              the whole tx reverts; the operator sweeps + retries.
///         **You MUST submit this via a private/Flashbots-Protect RPC** so the
///         seed tx is never in the public mempool — that removes the attacker's
///         ability to time a donation to your seed block.
///
/// @dev    Env vars:
///           TOWELI          — the TOWELI token address (required)
///           ROUTER          — TegridyRouter (required; WETH + FACTORY derived from it)
///           TO              — recipient of the LP tokens, e.g. treasury (required)
///           TOWELI_AMOUNT   — TOWELI to seed, in wei/base units (required)
///           ETH_AMOUNT      — native ETH to seed, in wei (required)
///           SLIPPAGE_BPS    — tolerance for the mins + post-check (optional, default 50 = 0.5%)
///           DEADLINE_MINUTES— tx deadline from now (optional, default 20)
///
/// @dev    Run (DRY-RUN FIRST — read every line before --broadcast):
///           forge script script/SeedLP.s.sol --rpc-url $FLASHBOTS_RPC --sender $TREASURY -vvv
///         Real run: add `--broadcast --private-key $KEY` with $FLASHBOTS_RPC a
///         private/Protect endpoint. Confirm the printed achieved-price is the
///         intended launch price before you walk away.
contract SeedLP is Script {
    uint256 constant BPS = 10_000;

    function run() external {
        address toweli = vm.envAddress("TOWELI");
        address router = vm.envAddress("ROUTER");
        address to = vm.envAddress("TO");
        uint256 toweliAmount = vm.envUint("TOWELI_AMOUNT");
        uint256 ethAmount = vm.envUint("ETH_AMOUNT");
        uint256 slippageBps = vm.envOr("SLIPPAGE_BPS", uint256(50));
        uint256 deadlineMin = vm.envOr("DEADLINE_MINUTES", uint256(20));

        require(toweli != address(0), "TOWELI required");
        require(router != address(0), "ROUTER required");
        require(to != address(0), "TO required");
        require(toweliAmount > 0 && ethAmount > 0, "amounts must be > 0");
        require(slippageBps <= 1000, "SLIPPAGE_BPS too high (>10%)");

        address weth = IRouterSeed(router).WETH();
        address factory = IRouterSeed(router).factory();
        address pair = IFactorySeed(factory).getPair(toweli, weth);

        // ── Pre-flight ────────────────────────────────────────────────
        console.log("=== SeedLP plan ===");
        console.log("TOWELI:      ", toweli);
        console.log("Router:      ", router);
        console.log("WETH:        ", weth);
        console.log("Factory:     ", factory);
        console.log("LP recipient:", to);
        console.log("TOWELI seed: ", toweliAmount);
        console.log("ETH seed:    ", ethAmount);
        console.log("Price (TOWELI per 1 ETH):", (toweliAmount * 1e18) / ethAmount);
        console.log("Existing pair:", pair);

        // Balance sanity — the broadcaster must hold the capital.
        require(IERC20Min(toweli).balanceOf(msg.sender) >= toweliAmount, "sender TOWELI balance < TOWELI_AMOUNT");
        require(msg.sender.balance >= ethAmount, "sender ETH balance < ETH_AMOUNT");

        // Abort if the pool is already seeded — this script is first-add only.
        if (pair != address(0)) {
            (uint112 r0, uint112 r1,) = IPairSeed(pair).getReserves();
            require(r0 == 0 && r1 == 0, "pair ALREADY SEEDED (reserves > 0) - abort");
        }

        uint256 tokenMin = (toweliAmount * (BPS - slippageBps)) / BPS;
        uint256 ethMin = (ethAmount * (BPS - slippageBps)) / BPS;

        vm.startBroadcast();

        // Defense 1: sweep any pre-donated (non-reserve) tokens off an existing
        // 0-reserve pair so they can't skew the first mint's price.
        if (pair != address(0)) {
            uint256 donatedT = IERC20Min(toweli).balanceOf(pair);
            uint256 donatedW = IERC20Min(weth).balanceOf(pair);
            if (donatedT > 0 || donatedW > 0) {
                console.log("Donation detected at pair - skimming to sender. TOWELI/WETH:", donatedT, donatedW);
                IPairSeed(pair).skim(msg.sender);
            }
        }

        // Approve exactly what we seed (reset-then-set to be safe with non-standard approve).
        IERC20Min(toweli).approve(router, 0);
        IERC20Min(toweli).approve(router, toweliAmount);

        (uint256 usedToken, uint256 usedEth, uint256 liquidity) = IRouterSeed(router).addLiquidityETH{value: ethAmount}(
            toweli, toweliAmount, tokenMin, ethMin, to, block.timestamp + deadlineMin * 60
        );

        vm.stopBroadcast();

        // ── Post-conditions (fail loud) ───────────────────────────────
        pair = IFactorySeed(factory).getPair(toweli, weth);
        require(pair != address(0), "POST: pair not created");
        require(IPairSeed(pair).balanceOf(to) > 0, "POST: LP not minted to recipient");

        (uint112 r0, uint112 r1,) = IPairSeed(pair).getReserves();
        address t0 = IPairSeed(pair).token0();
        (uint256 resToweli, uint256 resWeth) = t0 == toweli ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        // Price-conservation: achieved reserves must match intended within tolerance.
        // (First mint sends `desired` verbatim, so equality holds absent an unswept donation.)
        _assertWithin(resToweli, toweliAmount, slippageBps, "TOWELI reserve off intended");
        _assertWithin(resWeth, ethAmount, slippageBps, "WETH reserve off intended");

        console.log("");
        console.log("=== Seed complete ===");
        console.log("Pair:           ", pair);
        console.log("TOWELI used:    ", usedToken);
        console.log("ETH used:       ", usedEth);
        console.log("LP minted to TO:", liquidity);
        console.log("Achieved price (TOWELI per 1 ETH):", (resToweli * 1e18) / resWeth);
        console.log("");
        console.log("NEXT: run BootstrapTWAP.s.sol 4x >=15 min apart, then wait 60 min");
        console.log("      before any POL.accumulate (audit H-18). Verify with VerifyMVP.");
    }

    /// @dev |actual - intended| / intended <= toleranceBps, else revert `msg`.
    function _assertWithin(uint256 actual, uint256 intended, uint256 toleranceBps, string memory reason) internal pure {
        uint256 diff = actual > intended ? actual - intended : intended - actual;
        require(diff * BPS <= intended * toleranceBps, reason);
    }
}
